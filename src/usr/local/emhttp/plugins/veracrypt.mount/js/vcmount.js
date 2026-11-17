/*
 * vcmount.js: the behaviour of the volume list and the edit panel
 * (docs/DESIGN-ui.md). The Dashboard tile and the Main page section use it
 * too: a list marked data-compact gets the tile's rows, one marked data-main
 * the Main page's, and what is not on the page (the edit
 * panel, Mount all) is simply not there to be used.
 *
 * Every action is a POST to include/action.php with Unraid's CSRF token
 * (SEC-2). The password is read from the field, the field is emptied at once,
 * and the password is sent in the body of that one request. It is never put in
 * an address, stored or logged.
 */
(function ($) {
    'use strict';

    var URL = '/plugins/veracrypt.mount/include/action.php';
    var REFRESH = 5000;          // ask for the list every 5 seconds (U3)
    var NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
    var overHttp = window.location.protocol === 'http:';
    var httpsRequired = null;    // the setting "require HTTPS", from the list; null = not known yet

    var lastVolumes = [];        // the list as last shown
    var lastTile = null;         // the tile's list as last drawn, to leave it alone when nothing changed
    var mountTarget = null;      // the volume the dialog is for; null = mount once
    var mounting = false;        // a mount request is on its way; a second click is ignored
    var dismounting = {};        // volumes this page is dismounting now: shown busy, a second click is ignored
    var mountQueue = [];         // the volumes "Mount all" still has to ask for
    var inQueue = false;         // the dialog is part of "Mount all"

    var config = null;           // the saved settings as "vcmount config" returns them
    var options = null;          // users and containers for the forms
    var editing = null;          // the volume being edited: its saved name, '' for a new one, null = list shown
    var dirty = false;           // the edit panel has changes that are not saved
    var autoName = '';           // the name last filled in from the file name

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /** Send one action. Always resolves, with the engine's answer or an error. */
    function act(data) {
        data.csrf_token = csrf_token;
        return $.ajax({ url: URL, method: 'POST', data: data, dataType: 'json', timeout: 330000 })
            .then(function (answer) { return answer; },
                  function () { return { ok: false, code: 1, lost: true, error: 'No answer from the server.' }; });
    }

    function size(bytes) {
        if (bytes === null || bytes === undefined) { return '-'; }
        return bytes < 1e9 ? Math.round(bytes / 1e6) + ' MB' : (bytes / 1e9).toFixed(1) + ' GB';
    }

    function message(title, text, type) {
        swal({ title: title, text: text, type: type || 'info', html: true });
    }

    function accessText(access) {
        return access === 'read-write' ? 'read/write' : 'read-only';
    }

    // ---- The list --------------------------------------------------------

    /**
     * The tile's Share column: only the state, as icon and one word. The share's
     * name (the volume's name, which need not be its display name) is in the
     * tooltip. A volume mounted into a folder of an Unraid share has no share
     * of its own but is reachable through that one, so that share is named.
     */
    function tileShare(v) {
        var mountedNow = v.state === 'mounted';
        var point = v.mounted_at || v.mount_at || '';
        var inside = point.indexOf('/mnt/user/') === 0 ? point.split('/')[3] : '';
        var via = inside ? ' Also reachable through the Unraid share "' + inside + '".' : '';
        if (v.share) {
            var path = '\\\\' + window.location.hostname.toUpperCase() + '\\' + v.name;
            var users = Object.keys(v.share.users).map(function (u) {
                return u + ': ' + (v.read_only ? 'read-only' : accessText(v.share.users[u]));
            }).join(', ');
            if (!mountedNow) {
                return '<span class="vcm-dim" title="' + esc('Shared as ' + path + ' when mounted (' + users + ').' + via) + '">' +
                       '<i class="fa fa-fw fa-share-alt"></i> off</span>';
            }
            if (!v.share_active) {
                return '<span title="' + esc('The share ' + path + ' is not active. Check that SMB is enabled, then dismount and mount again.' + via) + '">' +
                       '<i class="fa fa-fw fa-exclamation-triangle orange-text"></i> failed</span>';
            }
            return '<span title="' + esc(path + ' \u00b7 ' + users + '.' + via) + '">' +
                   '<i class="fa fa-fw fa-share-alt"></i> on</span>';
        }
        if (inside) {
            return '<span' + (mountedNow ? '' : ' class="vcm-dim"') + ' title="' +
                   esc((mountedNow ? 'Mounted' : 'When mounted, it is') + ' inside the Unraid share "' + inside +
                       '" (' + point + ') and reachable through that share.') + '">' +
                   '<i class="fa fa-fw fa-folder-o"></i> ' + esc(inside) + '</span>';
        }
        return '-';
    }

    /** Replace the tile's rows. The header rows of the tile stay. */
    function tileRows(rows) {
        var tile = $('#vcm-rows');
        var folded = tile.children('tr.header').is(':hidden');
        tile.children('tr.vcm-row').remove();
        tile.append(rows);
        if (folded) { tile.children('tr.vcm-row').hide(); }
    }

    /**
     * The Dashboard tile, laid out like Unraid's Array tile: the lock mounts or
     * dismounts, the name opens the Edit screen, then status and how full the
     * volume is. No table inside the tile: see the tile's page.
     */
    function renderCompact(volumes) {
        // Drawn again only when something changed, so a lock under the mouse
        // keeps its preview and its tooltip between two refreshes.
        var now = JSON.stringify(volumes);
        if (now === lastTile) { return; }
        lastTile = now;
        // Without volumes there is nothing to show: the whole tile stays away.
        // Only a class is switched, so a tile the user closed stays closed.
        $('#vcm-rows').toggleClass('vcm-none', !volumes.length);
        var mounted = volumes.filter(function (v) { return v.state === 'mounted'; }).length;
        $('#vcm-tile-sub').text(mounted + ' of ' + volumes.length + ' mounted');
        if (!volumes.length) { tileRows(''); return; }
        tileRows(volumes.map(function (v) {
            var name = esc(v.name);
            // Icons, status dot and usage bar are written as Unraid's Array tile writes them.
            var locked = v.state === 'locked';
            var lock = '<i class="icon-u-lock' + (locked ? '' : '-open') + ' f14 vcm-tile-icon ' + esc(v.state);
            if (dismounting[v.name]) {
                lock = busyLock();
            } else if (locked && v.saved) {
                lock += ' vcm-mount" role="button" tabindex="0" data-name="' + name + '" title="Mount"></i>';
            } else if (!locked) {
                lock += ' vcm-dismount" role="button" tabindex="0" data-name="' + name + '" title="Dismount"></i>';
            } else {
                lock += '"></i>';
            }
            var label = v.saved
                ? '<a href="/Settings/VeraCryptMount?edit=' + encodeURIComponent(v.name) + '" title="' + esc(v.display_name) + ' settings">' + esc(v.display_name) + '</a>'
                : '<span title="' + esc(v.display_name) + ', not saved">' + esc(v.display_name) + '</span>';
            var orb = v.state === 'mounted' ? 'green' : (locked ? 'grey' : 'yellow');
            var state = '<i class="fa fa-circle orb ' + orb + '-orb middle"></i>' + esc(v.state) +
                        (v.read_only && v.state === 'mounted' ? ' <span class="vcm-ro" title="Mounted read-only">ro</span>' : '');
            var usage = '<span class="load">-</span><div class="usage-disk sys none"><span></span></div>';
            if (v.state === 'mounted' && v.size_bytes > 0) {
                var percent = Math.round(100 * (v.size_bytes - v.free_bytes) / v.size_bytes);
                usage = '<span class="load">' + percent + '%</span>' +
                        '<div class="usage-disk sys" title="' + size(v.free_bytes) + ' free of ' + size(v.size_bytes) + '">' +
                        '<span class="' + barClass(percent, false) + '" style="width:' + percent + '%"></span><span></span></div>';
            }
            return '<tr class="vcm-row"><td>' +
                   '<span class="vcm-col-name">' + lock + ' ' + label + '</span>' +
                   '<span class="w18">' + tileShare(v) + '</span>' +
                   '<span class="w18">' + state + '</span>' +
                   '<span class="w18">' + usage + '</span>' +
                   '</td></tr>';
        }).join(''));
    }

    /**
     * The colour class of a usage bar, as Unraid's usage_color() picks it
     * (dynamix/include/Helpers.php): none when the display settings show bars
     * without colour, otherwise green, orange from the warning level and red from
     * the critical level. For a bar of free space the levels count from the top.
     */
    function barClass(percent, free) {
        var d = $('#vcm-display');
        var text = parseInt(d.attr('data-text'), 10) || 0;
        if (text === 1 || Math.floor(text / 10) === 1) { return ''; }
        var warning = parseInt(d.attr('data-warning'), 10) || 0;
        var critical = parseInt(d.attr('data-critical'), 10) || 0;
        if (free) {
            if (critical > 0 && percent <= 100 - critical) { return 'redbar'; }
            if (warning > 0 && percent <= 100 - warning) { return 'orangebar'; }
            return 'greenbar';
        }
        if (critical > 0 && percent >= critical) { return 'redbar'; }
        if (warning > 0 && percent >= warning) { return 'orangebar'; }
        return 'greenbar';
    }

    /**
     * The drive icon in front of a volume file: like Unraid's disks, a link with
     * a tooltip that opens the volume's information window.
     */
    function infoIcon(name) {
        return '<a class="info hand vcm-info" data-name="' + esc(name) + '">' +
               '<i class="icon-disk-encrypted icon"></i><span>Volume information</span></a>';
    }

    /** A link to Unraid's file manager for a folder, written as the Main page writes it. */
    function browseLink(dir) {
        return '<a class="view info" href="/Main/Browse?dir=' + encodeURIComponent(dir) + '">' +
               '<i class="fa fa-folder-o"></i><span>Open in File Manager</span></a>';
    }

    /**
     * The lock in front of a name: status and control in one, as the coloured
     * dot is for a disk, with the text for Unraid's own help bubble.
     */
    function lockOf(v) {
        var name = esc(v.name);
        var locked = v.state === 'locked';
        var lock = '<i class="icon-u-lock' + (locked ? '' : '-open') + ' f14 vcm-tile-icon ' + esc(v.state);
        if (dismounting[v.name]) {
            return { html: busyLock(), help: 'Dismounting… ' + DISMOUNT_WAIT };
        }
        if (locked && v.saved) {
            return { html: lock + ' vcm-mount" role="button" tabindex="0" data-name="' + name + '"></i>',
                     help: 'Locked. Click to mount.' };
        }
        if (!locked) {
            return { html: lock + ' vcm-dismount" role="button" tabindex="0" data-name="' + name + '"></i>',
                     help: (v.state === 'mounted' ? 'Mounted' + (v.read_only ? ' read-only' : '') : 'Unlocked, but not mounted') +
                           '. Click to dismount.' };
        }
        return { html: lock + '"></i>', help: 'Locked.' };
    }

    /** The start of a row, as in a disk's row: folder (or its empty place), lock, name. */
    function rowStart(v, label) {
        var lock = lockOf(v);
        var view = v.state === 'mounted' && v.mounted_at ? browseLink(v.mounted_at) : '<a class="view"></a>';
        return view + '<a class="info">' + lock.html + '<span>' + lock.help + '</span></a>' + label;
    }

    /**
     * One row of the Main page section, in the manner of Unraid's device
     * tables around it: the name opens Edit, and "Mounted at" spans three of
     * Unraid's narrow columns.
     */
    function deviceRow(v) {
        var mountedNow = v.state === 'mounted';
        var title = esc(v.display_name) + (v.display_name !== v.name ? ' (' + esc(v.name) + ')' : '');
        var label = v.saved
            ? '<a href="/Settings/VeraCryptMount?edit=' + encodeURIComponent(v.name) + '" title="' + title + ' settings">' + esc(v.display_name) + '</a>'
            : esc(v.display_name) + ' <span class="vcm-dim">(not saved)</span>';
        if (v.read_only && mountedNow) { label += ' <span class="vcm-ro" title="Mounted read-only">ro</span>'; }
        var known = mountedNow && v.size_bytes > 0;
        var sizes = '<td>-</td><td>-</td><td>-</td>';
        if (known) {
            var usedPart = Math.round(100 * (v.size_bytes - v.free_bytes) / v.size_bytes);
            sizes = '<td>' + size(v.size_bytes) + '</td>' +
                    '<td><div class="usage-disk"><span class="' + barClass(usedPart, false) + '" style="width:' + usedPart + '%"></span>' +
                    '<span>' + size(v.size_bytes - v.free_bytes) + '</span></div></td>' +
                    '<td><div class="usage-disk"><span class="' + barClass(100 - usedPart, true) + '" style="width:' + (100 - usedPart) + '%"></span>' +
                    '<span>' + size(v.free_bytes) + '</span></div></td>';
        }
        return '<tr>' +
            '<td>' + rowStart(v, label) + '</td>' +
            '<td>' + infoIcon(v.name) + esc(v.file || '-') + '</td>' +
            '<td colspan="3">' + esc(v.mounted_at || '-') + '</td>' +
            '<td>' + tileShare(v) + '</td>' +
            '<td>' + esc(mountedNow && v.filesystem ? v.filesystem : '-') + '</td>' +
            sizes + '</tr>';
    }

    /** Two lines in one cell: the main fact, and the details in small grey text. */
    function twoLines(first, second, title, open) {
        return '<div class="vcm-l1' + (open ? ' vcm-open' : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + first + '</div>' +
               (second ? '<div class="vcm-l2">' + second + '</div>' : '');   // no second line that only says "nothing"
    }

    /** The Share cell of the Volumes tab: state above, address and users below. */
    function shareCell(v) {
        var mountedNow = v.state === 'mounted';
        var point = v.mounted_at || v.mount_at || '';
        var inside = point.indexOf('/mnt/user/') === 0 ? point.split('/')[3] : '';
        if (v.share) {
            var path = '\\\\' + window.location.hostname.toUpperCase() + '\\' + v.name;
            var users = Object.keys(v.share.users).map(function (u) {
                return u + ' ' + (v.read_only ? 'read-only' : accessText(v.share.users[u]));
            });
            if (v.share.export === 'hidden') { users.push('hidden'); }
            var details = esc(path) + ' · ' + esc(users.join(', '));
            if (!mountedNow) {
                return twoLines('<span class="vcm-dim"><i class="fa fa-fw fa-share-alt"></i> off until mounted</span>', details);
            }
            if (!v.share_active) {
                return twoLines('<i class="fa fa-fw fa-exclamation-triangle orange-text"></i> failed', details,
                                'The share is not active. Check that SMB is enabled, then dismount and mount again.');
            }
            return twoLines('<i class="fa fa-fw fa-share-alt"></i> on', details);
        }
        if (inside) {
            return twoLines('<i class="fa fa-fw fa-folder-o"></i> via ' + esc(inside),
                            'inside the Unraid share "' + esc(inside) + '"');
        }
        return twoLines('<span class="vcm-dim">-</span>', '');
    }

    /** The Usage cell of the Volumes tab: one bar above, free space and filesystem below. */
    function usageCell(v) {
        if (v.state === 'mounted' && v.size_bytes > 0) {
            var used = Math.round(100 * (v.size_bytes - v.free_bytes) / v.size_bytes);
            return twoLines('<span class="vcm-bar"><span class="' + barClass(used, false) + '" style="width:' + used + '%"></span></span>' + used + '%',
                            size(v.free_bytes) + ' free of ' + size(v.size_bytes) + (v.filesystem ? ' · ' + esc(v.filesystem) : ''));
        }
        return twoLines('<span class="vcm-dim">-</span>', v.state === 'unlocked' ? 'unlocked, not mounted' : '');
    }

    /**
     * One row of the Volumes tab: two lines per cell, so the facts fit without
     * a column for each. The buttons say plainly what they do; the lock works
     * too, as on the tile and the Main page.
     */
    function volumeRow(v) {
        var name = esc(v.name);
        var mountedNow = v.state === 'mounted';
        var title = v.display_name + (v.display_name !== v.name ? ' (' + v.name + ')' : '');
        // The folder and the lock sit beside both lines, centred, outside the
        // text that is cut short with "…", so the lock's help bubble is never cut off.
        var label = esc(v.display_name) +
                    (v.saved ? '' : ' <span class="vcm-dim">(not saved)</span>') +
                    (v.read_only && mountedNow ? ' <span class="vcm-ro" title="Mounted read-only">ro</span>' : '');
        var where = esc(v.file || '?') + ' &rarr; ' + esc(v.mounted_at || v.mount_at || '-');
        var deps = v.dependents || [];
        var buttons = '';
        if (dismounting[v.name]) {
            buttons += '<input type="button" disabled value="Dismounting…" title="' + DISMOUNT_WAIT + '">';
        } else if (v.state === 'locked' && v.saved) {
            buttons += '<input type="button" class="vcm-mount" data-name="' + name + '" value="Mount">';
        } else if (v.state !== 'locked') {
            buttons += '<input type="button" class="vcm-dismount" data-name="' + name + '" value="Dismount">';
        }
        if (v.saved) {
            buttons += '<input type="button" class="vcm-edit" data-name="' + name + '" value="Edit">';
        }
        return '<tr>' +
            '<td><div class="vcm-vol"><span class="vcm-vol-icons">' + rowStart(v, '') + infoIcon(v.name) + '</span>' +
                '<div class="vcm-vol-text">' + twoLines(label, where, title) + '</div></div></td>' +
            '<td>' + shareCell(v) + '</td>' +
            '<td>' + (deps.length
                ? twoLines(deps.length + (deps.length === 1 ? ' container' : ' containers'), esc(deps.join(', ')),
                           'Started in this order, stopped in reverse: ' + deps.join(', '))
                : twoLines('<span class="vcm-dim">-</span>', '')) + '</td>' +
            '<td>' + usageCell(v) + '</td>' +
            '<td class="vcm-actions">' + buttons + '</td>' +
            '</tr>';
    }

    /** The Main page section and the Volumes tab, drawn again only when something changed. */
    function renderDevices(volumes, manage) {
        var now = JSON.stringify(volumes);
        if (now === lastTile) { return; }
        lastTile = now;
        var rows = $('#vcm-rows').empty();
        if (!volumes.length) {
            rows.append('<tr><td colspan="10" class="vcm-empty">' + (manage
                ? 'No volumes are saved and none is mounted. Use "Add volume".'
                : 'No volumes are saved. <a href="/Settings/VeraCryptMount">Add one</a>.') + '</td></tr>');
            return;
        }
        volumes.forEach(function (v) { rows.append(manage ? volumeRow(v) : deviceRow(v)); });
    }

    function render(volumes) {
        lastVolumes = volumes;
        if ($('#vcm-rows').is('[data-compact]')) { renderCompact(volumes); return; }
        renderDevices(volumes, !$('#vcm-rows').is('[data-main]'));
    }

    function refresh() {
        if (document.hidden) { return $.Deferred().resolve(); }
        return act({ action: 'list' }).then(function (a) {
            if (a.ok) {
                if (a.settings) { httpsRequired = !!a.settings.require_https; }
                render(a.volumes || []);
            } else {
                if ($('#vcm-rows').is('[data-compact]')) {
                    lastTile = null;
                    $('#vcm-rows').removeClass('vcm-none');
                    tileRows('<tr class="vcm-row"><td class="vcm-empty">' + esc(a.error) + '</td></tr>');
                } else {
                    lastTile = null;
                    $('#vcm-rows').html('<tr><td colspan="10' +
                                        '" class="vcm-empty">' + esc(a.error) + '</td></tr>');
                }
            }
        });
    }

    // ---- Volume information ---------------------------------------------

    /** One labelled line of the information window; nothing when there is no value. */
    function infoRow(label, value) {
        return value === null || value === undefined || value === '' ? ''
            : '<dt>' + esc(label) + '</dt><dd>' + value + '</dd>';
    }

    /**
     * Show what "vcmount info" reports about one volume, read-only, in a window
     * in the style of the mount dialog. Built when first needed.
     */
    function showInfo(name) {
        act({ action: 'info', name: name }).then(function (a) {
            if (!a.ok) { message('No information', esc(a.error || 'The volume could not be read.'), 'error'); return; }
            var v = a.volume;
            var html = '<dl class="vcm-info-list">' +
                infoRow('State', esc(v.state) + (v.read_only && v.state === 'mounted' ? ', read-only' : '') +
                        (v.saved ? '' : ' (not saved)')) +
                infoRow('Volume file', esc(v.file || '-')) +
                infoRow('File', a.file ? size(a.file.size_bytes) + ', changed ' +
                        esc(new Date(a.file.modified).toLocaleString()) : null);
            if (a.crypt) {
                html += infoRow('Encryption', esc((a.crypt.cipher || '?') + (a.crypt.keysize ? ', key ' + a.crypt.keysize : ''))) +
                        infoRow('Device', esc((a.crypt.device || '') + (a.crypt.mode ? ', ' + a.crypt.mode : '')));
            }
            if (a.filesystem) {
                html += infoRow('File system', esc([a.filesystem.type, a.filesystem.driver ? 'driver ' + a.filesystem.driver : ''].filter(Boolean).join(', '))) +
                        infoRow('Label', a.filesystem.label ? esc(a.filesystem.label) : null) +
                        infoRow('UUID', a.filesystem.uuid ? esc(a.filesystem.uuid) : null) +
                        infoRow('Options', a.filesystem.options ? '<code>' + esc(a.filesystem.options) + '</code>' : null);
            }
            html += infoRow('Mounted at', v.mounted_at ? esc(v.mounted_at) : null);
            if (a.top_folder) {
                var actions = '';
                if (a.top_folder.owners && v.state === 'mounted' && !v.read_only) {
                    if (!a.top_folder.share_can_write) {
                        actions += ' <a href="#" class="vcm-fix-top" data-name="' + esc(v.name) + '">Let the share write</a>';
                    }
                    actions += ' <a href="#" class="vcm-fix-perms" data-name="' + esc(v.name) + '">Fix permissions…</a>';
                }
                html += infoRow('Top folder', esc(a.top_folder.owner) + ', ' + esc(a.top_folder.mode) + actions);
            }
            if (v.state === 'mounted' && v.size_bytes > 0) {
                html += infoRow('Usage', size(v.size_bytes - v.free_bytes) + ' used, ' + size(v.free_bytes) + ' free of ' + size(v.size_bytes));
            }
            html += infoRow('Share', v.share ? $('<div>').html(shareCell(v)).text().replace(/\s+/g, ' ') : 'not shared');
            html += infoRow('Dependents', (a.dependents || []).length ? a.dependents.map(function (d) {
                return esc(d.container) + ' <span class="vcm-dim">(' + esc(d.state) + ', stop within ' + esc(d.grace) + ' s)</span>';
            }).join('<br>') : 'none') + '</dl>';
            if (v.saved && !a.log_names) {
                html += '<h4>Recent log</h4><p class="vcm-note">Names are not shown in the logs (Settings tab, ' +
                        '"Show volume names in logs"), so there is no history for this volume.</p>';
            } else if (v.saved) {
                html += '<h4>Recent log</h4>' + ((a.log || []).length
                    ? '<pre class="vcm-info-log">' + a.log.map(esc).join('\n') + '</pre>'
                    : '<p class="vcm-note">Nothing about this volume in the current system log.</p>');
            }

            var box = $('#vcm-info');
            if (!box.length) {
                box = $('<div id="vcm-info" class="vcm-modal" hidden><div class="vcm-box vcm-info-box" role="dialog" aria-labelledby="vcm-info-title">' +
                        '<h3 id="vcm-info-title"></h3><div id="vcm-info-body"></div>' +
                        '<div class="vcm-buttons"><input type="button" id="vcm-info-close" value="Close"></div></div></div>').appendTo('body');
                box.on('click', function (e) { if (e.target === this) { box.prop('hidden', true); } });
                $('#vcm-info-close').on('click', function () { box.prop('hidden', true); });
                $(document).on('keydown', function (e) { if (e.key === 'Escape') { box.prop('hidden', true); } });
            }
            $('#vcm-info-body').off('click').on('click', '.vcm-fix-top', function (e) {
                e.preventDefault();
                act({ action: 'fix-top', name: $(this).attr('data-name') }).then(function (f) {
                    if (f.ok) { showInfo(name); } else { message('Could not change the top folder', esc(f.error), 'error'); }
                });
            }).on('click', '.vcm-fix-perms', function (e) {
                e.preventDefault();
                var target = $(this).attr('data-name');
                swal({
                    title: 'Fix permissions of ' + esc(v.display_name) + '?',
                    text: 'Everything inside the volume will belong to nobody:users, with folders writable for all and ' +
                          'files readable and writable for all, as Unraid\'s "New Permissions" tool does. ' +
                          'This can break containers that need their own owners, such as databases. It cannot be undone.',
                    type: 'warning', html: true, showCancelButton: true, confirmButtonText: 'Fix permissions', closeOnConfirm: false
                }, function () {
                    act({ action: 'fix-permissions', name: target }).then(function (f) {
                        message(f.ok ? 'Started' : 'Could not start', esc(f.ok ? f.message : f.error), f.ok ? 'success' : 'error');
                    });
                });
            });
            $('#vcm-info-title').text(v.display_name);
            $('#vcm-info-body').html(html);
            box.prop('hidden', false);
            $('#vcm-info-close').trigger('focus');
        });
    }

    // ---- Activity loggers (PRIV-3) --------------------------------------

    /**
     * Show the File Activity warning while it does not leave out every folder,
     * with the one exclusion line that covers them all. The engine reads File
     * Activity's settings and never changes them.
     */
    function checkPrivacy() {
        if (!$('#vcm-privacy').length) { return; }
        act({ action: 'privacy' }).then(function (a) {
            var fa = a.ok ? a.file_activity : null;
            var missing = fa && fa.installed ? fa.missing : [];
            $('#vcm-privacy-folders').html(missing.map(function (d) { return '<code>' + esc(d) + '</code>'; }).join(', '));
            $('#vcm-privacy-line').val(fa ? fa.line : '');
            $('#vcm-privacy-copied').prop('hidden', true);
            $('#vcm-privacy').prop('hidden', !missing.length);
        });
    }

    /** Copy the line. Plain HTTP has no clipboard access for pages, so the old way is used. */
    function copyPrivacyLines() {
        var box = $('#vcm-privacy-line')[0];
        box.focus();
        box.select();
        var done = false;
        try { done = document.execCommand('copy'); } catch (e) { done = false; }
        $('#vcm-privacy-copied').text(done ? 'Copied.' : 'Selected. Press Ctrl+C to copy.').prop('hidden', false);
    }

    // ---- The mount dialog -----------------------------------------------

    /**
     * Review P1: with "require HTTPS" on, a page opened over plain HTTP must not
     * offer the password field at all; the server's refusal would come only
     * after the password had crossed the network. The server keeps its check
     * as the second line of defence.
     */
    function passwordBlocked() {
        return overHttp && httpsRequired !== false;
    }

    function openDialog(name) {
        // Over plain HTTP the setting must be known first; until then, ask for it.
        if (overHttp && httpsRequired === null) {
            act({ action: 'list' }).then(function (a) {
                httpsRequired = a.ok && a.settings ? !!a.settings.require_https : true;
                openDialog(name);
            });
            return;
        }
        var blocked = passwordBlocked();
        mountTarget = name;
        var once = name === null;
        $('#vcm-mount-title').text(once ? 'Mount a file once' : 'Mount ' + name);
        $('#vcm-user').val(once ? '' : 'veracrypt:' + name);
        $('#vcm-once-fields').prop('hidden', !once);
        $('#vcm-password').val('').attr('autocomplete', once ? 'off' : 'current-password');
        $('#vcm-mount-error').prop('hidden', true).text('');
        $('#vcm-dialog-http').prop('hidden', !overHttp || blocked);
        $('#vcm-dialog-https').prop('hidden', !blocked);
        $('#vcm-https-link').attr('href', 'https://' + window.location.host + window.location.pathname + window.location.search);
        $('#vcm-password-label, #vcm-mount-submit').toggle(!blocked);
        $('#vcm-once-fields').prop('hidden', !once || blocked);
        $('#vcm-password').prop('disabled', blocked);
        $('#vcm-skip').prop('hidden', !inQueue);
        $('#vcm-mount-submit').prop('disabled', blocked).val('Mount');
        $('#vcm-modal').prop('hidden', false);
        $(blocked ? '#vcm-cancel' : (once ? '#vcm-file' : '#vcm-password')).trigger('focus');
    }

    function closeDialog() {
        if (mounting) { return; }   // not while a mount is on its way
        $('#vcm-password').val('');
        $('#vcm-modal').prop('hidden', true);
        mountTarget = null;
    }

    /** "Mount all" (VOL-6): ask for the next volume in the queue, or finish. */
    function nextInQueue() {
        if (mountQueue.length) {
            inQueue = true;
            openDialog(mountQueue.shift());
        } else {
            inQueue = false;
            refresh();
        }
    }

    function stopQueue() {
        mountQueue = [];
        inQueue = false;
    }

    function mountAll() {
        mountQueue = lastVolumes.filter(function (v) { return v.saved && v.state === 'locked'; })
                                .map(function (v) { return v.name; });
        if (!mountQueue.length) {
            message('Nothing to mount', 'Every saved volume is already mounted.', 'info');
            return;
        }
        nextInQueue();
    }

    function dialogError(text) {
        mounting = false;
        $('#vcm-mount-error').text(text).prop('hidden', false);
        $('#vcm-mount-submit').prop('disabled', false).val('Mount');
    }

    function mounted(a) {
        mounting = false;
        closeDialog();
        var notes = [];
        if (a.share_error) { notes.push(esc(a.share_error)); }
        (a.failed_dependents || []).forEach(function (f) {
            notes.push('Dependent ' + esc(f.container) + ' could not be started: ' + esc(f.reason));
        });
        if (notes.length) { message('Mounted, with problems', notes.join('<br>'), 'warning'); }
        refresh();
        var next = function () { if (inQueue) { nextInQueue(); } };
        if (a.top_folder_blocked && !notes.length) { askTopFolder(a.volume, next); } else { next(); }
    }

    /**
     * After mounting an ext4, XFS or Btrfs volume whose share gives someone
     * write access: its top folder belongs to another user, so the share
     * (which writes as nobody:users) cannot write. Ask before changing it; the
     * mount never changes permissions by itself.
     */
    function askTopFolder(v, done) {
        var writers = Object.keys((v.share && v.share.users) || {}).filter(function (u) {
            return v.share.users[u] === 'read-write';
        });
        var path = '\\\\' + window.location.hostname.toUpperCase() + '\\' + v.name;
        swal({
            title: 'Allow writing over the network?',
            text: 'The share ' + esc(path) + ' gives ' + esc(writers.join(', ')) + ' write access, but the top folder of ' +
                  esc(v.display_name) + ' belongs to another user, so the share cannot write to it.<br><br>' +
                  'Set the top folder to owner nobody:users and make it writable? Nothing inside the volume is changed.',
            type: 'info', html: true, showCancelButton: true,
            confirmButtonText: 'Set it', cancelButtonText: 'Not now', closeOnConfirm: false
        }, function (yes) {
            if (!yes) { done(); return; }
            act({ action: 'fix-top', name: v.name }).then(function (f) {
                if (f.ok) { swal.close(); } else { message('Could not change the top folder', esc(f.error), 'error'); }
                done();
            });
        });
    }

    /**
     * The answer to a mount was lost (a dropped connection), or the engine was
     * busy, possibly with a copy of this same request that the browser sent
     * again on its own. Wait until no vcmount action runs, then report from the
     * volume's real state instead of guessing.
     */
    function settle(name, lost) {
        $('#vcm-mount-submit').val('Checking…');
        var tries = 0;
        (function poll() {
            act({ action: 'busy' }).then(function (b) {
                if ((!b.ok || b.busy) && ++tries < 120) {
                    setTimeout(poll, 2000);
                    return;
                }
                act({ action: 'status', name: name }).then(function (s) {
                    if (s.ok && s.volume && s.volume.state === 'mounted') {
                        mounted({});
                    } else if (lost) {
                        dialogError('The answer from the server was lost, and the volume is not mounted. '
                            + 'Most likely the password was wrong. Please try again.');
                    } else {
                        dialogError('Another action was running, so nothing was done. Please try again.');
                    }
                });
            });
        }());
    }

    function submitMount(event) {
        event.preventDefault();
        if (mounting || passwordBlocked()) { return; }   // never send a password the setting forbids
        mounting = true;
        var once = mountTarget === null;
        var field = $('#vcm-password');
        var data = { action: once ? 'mount-once' : 'mount', name: once ? $.trim($('#vcm-name').val()) : mountTarget };
        if (once) {
            data.file = $.trim($('#vcm-file').val());
            data.read_only = $('#vcm-read-only').is(':checked') ? '1' : '0';
        }
        data.password = field.val();
        field.val('');
        $('#vcm-mount-error').prop('hidden', true);
        $('#vcm-mount-submit').prop('disabled', true).val('Unlocking…');

        var name = data.name;
        act(data).then(function (a) {
            if (a.ok) {
                mounted(a);
            } else if (a.lost || a.code === 6) {
                settle(name, !!a.lost);
            } else {
                dialogError(a.error || 'The volume could not be mounted.');
                field.trigger('focus');
            }
        });
        data.password = null;
    }

    // ---- Dismount ---------------------------------------------------------

    function heldBy(a) {
        var programs = (a.details && a.details.programs) || [];
        return programs.length ? '<br><br>Held open by:<br>' + programs.map(esc).join('<br>') : '';
    }

    /**
     * Mark volumes as being dismounted on this page and draw the lists again,
     * so their controls show it at once. A dismount stops the dependents first,
     * each within its grace period, so it can take minutes.
     */
    function setDismounting(names, on) {
        names.forEach(function (n) { if (on) { dismounting[n] = true; } else { delete dismounting[n]; } });
        lastTile = null;
        render(lastVolumes);
    }

    var DISMOUNT_WAIT = 'Stopping its dependents first, each within its grace period. This can take a while.';

    /** The spinning stand-in for a lock on the tile and the Main page. */
    function busyLock() {
        return '<i class="fa fa-fw fa-circle-o-notch fa-spin vcm-tile-icon vcm-busy" title="Dismounting… ' + DISMOUNT_WAIT + '"></i>';
    }

    function notesOf(a) {
        return (a.notes || []).map(esc).join('<br>');
    }

    function dismount(name) {
        if (dismounting[name]) { return; }
        setDismounting([name], true);
        act({ action: 'dismount', name: name }).then(function (a) {
            setDismounting([name], false);
            refresh();
            if (a.ok) {
                if ((a.notes || []).length) { message('Dismounted ' + esc(name), notesOf(a), 'info'); }
                return;
            }
            if (a.code !== 5) {
                message('Could not dismount', esc(a.error), 'error');
                return;
            }
            // Busy: nothing was forced. Offer it, with a second confirmation (LIFE-5).
            swal({
                title: esc(name) + ' is still in use',
                text: 'It stays mounted; nothing was forced.' + heldBy(a),
                type: 'warning', html: true,
                showCancelButton: true, confirmButtonText: 'Force dismount', closeOnConfirm: false
            }, function () {
                swal({
                    title: 'Force the dismount?',
                    text: 'Programs that hold ' + esc(name) + ' open are ended, and containers that use it are stopped. Unsaved work in them is lost.',
                    type: 'warning', html: true,
                    showCancelButton: true, confirmButtonText: 'Yes, force it', closeOnConfirm: false
                }, function () {
                    setDismounting([name], true);
                    act({ action: 'dismount-force', name: name }).then(function (f) {
                        setDismounting([name], false);
                        refresh();
                        if (f.ok) {
                            message('Dismounted ' + esc(name), notesOf(f) || 'Done.', 'success');
                        } else {
                            message('Could not dismount', esc(f.error) + heldBy(f), 'error');
                        }
                    });
                });
            });
        });
    }

    /** A lock (tile, Main page, Volumes tab) is one click away, so a dismount through it is confirmed first. */
    function confirmDismount(name) {
        var deps = [];
        lastVolumes.forEach(function (v) { if (v.name === name) { deps = v.dependents || []; } });
        swal({
            title: 'Dismount ' + esc(name) + '?',
            text: deps.length ? 'Its dependents are stopped first: ' + esc(deps.join(', ')) + '.' : 'Nothing is forced.',
            type: 'warning', html: true, showCancelButton: true, confirmButtonText: 'Dismount'
        }, function () { dismount(name); });
    }

    function dismountAll() {
        swal({
            title: 'Dismount all volumes?',
            text: 'Their dependents are stopped first. Nothing is forced.',
            type: 'warning', showCancelButton: true, confirmButtonText: 'Dismount all', closeOnConfirm: false
        }, function () {
            var names = lastVolumes.filter(function (v) { return v.state !== 'locked'; })
                                   .map(function (v) { return v.name; });
            setDismounting(names, true);
            $('#vcm-dismount-all').prop('disabled', true).val('Dismounting…');
            swal.close();
            act({ action: 'dismount-all' }).then(function (a) {
                setDismounting(names, false);
                $('#vcm-dismount-all').prop('disabled', false).val('Dismount all');
                refresh();
                var lines = (a.results || []).map(function (r) {
                    return r.ok ? esc(r.message) : esc(r.error) + heldBy(r);
                });
                if (!a.results && a.error) { lines.push(esc(a.error)); }
                message(a.ok ? 'Done' : 'Not everything was dismounted',
                        lines.length ? lines.join('<br>') : 'No volume was mounted.', a.ok ? 'success' : 'warning');
            });
        });
    }

    // ---- The edit panel ---------------------------------------------------

    function editError(text) {
        $('#vcm-edit-error').text(text).prop('hidden', !text);
    }

    function userRow(user, access) {
        var choice = function (value, label) {
            return '<option value="' + value + '"' + (access === value ? ' selected' : '') + '>' + label + '</option>';
        };
        return '<tr><td>' + esc(user) + '</td><td><select class="e-access" data-user="' + esc(user) + '">' +
            choice('none', 'No access') + choice('read-only', 'Read-only') + choice('read-write', 'Read/Write') +
            '</select> <span class="vcm-note vcm-ro-hint" hidden>read-only while the volume is mounted read-only</span></td></tr>';
    }

    function depItem(dep) {
        var known = (options.containers || []).indexOf(dep.container) >= 0;
        return $('<li class="vcm-dep">' +
            '<span class="vcm-handle" title="Drag to reorder">&#9776;</span>' +
            '<span class="vcm-dep-name">' + esc(dep.container) + (known ? '' : ' <em>(not found)</em>') + '</span>' +
            '<label>stop within <input type="number" class="e-grace" min="1" max="600" value="' + esc(dep.grace) + '"> s</label>' +
            '<label>then wait <input type="number" class="e-delay" min="0" max="600" value="' + esc(dep.delay) + '"> s</label>' +
            '<a href="#" class="vcm-dep-remove" title="Remove">&#10005;</a>' +
            '</li>').attr('data-container', dep.container);
    }

    function depChoices() {
        var used = $('#e-deps li').map(function () { return $(this).attr('data-container'); }).get();
        var free = (options.containers || []).filter(function (c) { return used.indexOf(c) < 0; });
        $('#e-dep-choice').html(free.length
            ? free.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('')
            : '<option value="">(no other containers)</option>');
    }

    function updateSummaries() {
        var share = 'not shared';
        if ($('#e-share').val() === 'yes') {
            var users = $('.e-access').filter(function () { return $(this).val() !== 'none'; }).map(function () {
                var access = $(this).val();
                if (access === 'read-write' && $('#e-ro').is(':checked')) { access = 'read-only'; }
                return $(this).attr('data-user') + ': ' + accessText(access);
            }).get();
            share = (users.length ? users.join(', ') : 'no user has access') +
                    ($('#e-export').val() === 'hidden' ? ', hidden' : '');
        }
        $('#s-share').text(share);
        var deps = $('#e-deps li').map(function () { return $(this).attr('data-container'); }).get();
        $('#s-deps').text(deps.length ? deps.join(', ') : 'none');
        var name = $.trim($('#e-name').val());
        var point = $('#e-mount-mode').val() === 'share' ? $.trim($('#e-mount-at').val()) : '/mnt/addons/' + name;
        var display = $.trim($('#e-display').val());
        $('#s-adv').text((display && display !== name ? display + ' · ' : '') + point);
    }

    /**
     * A volume mounted read-only cannot be written to over the network either.
     * The saved access is left alone, so unticking the switch loses nothing;
     * users with "Read/Write" get a hint instead. The engine leaves out write
     * access on the server while the volume is mounted read-only.
     */
    function applyReadOnly() {
        var ro = $('#e-ro').is(':checked');
        $('.e-access').each(function () {
            $(this).siblings('.vcm-ro-hint').prop('hidden', !(ro && $(this).val() === 'read-write'));
        });
        $('#e-ro-note').toggle(ro && $('#e-share').val() === 'yes');
    }

    // ---- Breadcrumb ---------------------------------------------------------

    var titleBar = null;   // Unraid's title bar above this page, if there is one
    var titleHtml = '';    // its own content, put back when the panel closes

    /**
     * Show "Volumes > here" as Unraid's file manager does: in the page's title
     * bar. Pages shown as tabs have no title bar; then the page's own crumb
     * line is used instead.
     */
    function setCrumb(here) {
        if (titleBar === null) {
            // The tab's own bar (or Unraid's, when the page is shown without tabs).
            titleBar = $('#vcm-list').prevAll('div.title').first().children('.left').first();
            titleHtml = titleBar.html() || '';
        }
        var html = '<a href="#" class="none vcm-crumb-back"><i class="fa fa-lock"></i> Volumes</a>' +
                   '<i class="fa fa-chevron-right vcm-chevron"></i><span>' + esc(here) + '</span>';
        if (titleBar.length) {
            titleBar.html(html);
            $('#vcm-crumb, #vcm-edit-title').hide();
        } else {
            $('#vcm-crumb').html(html).show();
            $('#vcm-edit-title').text(here).show();
        }
    }

    function clearCrumb() {
        if (titleBar && titleBar.length) { titleBar.html(titleHtml); }
    }

    /** Show only the fields that apply (as in the mockup: hidden, not greyed out). */
    function toggleFields() {
        applyReadOnly();
        $('.vcm-share-on').toggle($('#e-share').val() === 'yes');
        $('.vcm-mount-share').toggle($('#e-mount-mode').val() === 'share');
        var name = $.trim($('#e-name').val());
        $('#e-own-point').text(name ? '/mnt/addons/' + name : '');
        updateSummaries();
    }

    /**
     * Unraid's own pages: Apply is greyed out until something changes, and Done
     * turns into Reset. The page does this itself (the buttons carry the class
     * "lock", so Unraid's version, which reloads the page, leaves them alone),
     * because fields added later are not seen by Unraid's version.
     */
    function markDirty() {
        dirty = true;
        $('#e-apply').prop('disabled', false);
        $('#e-done').val('Reset');
    }

    function markClean() {
        dirty = false;
        $('#e-apply').prop('disabled', true);
        $('#e-done').val('Done');
    }

    /** A volume name made from a file name: "My Files.hc" becomes "My-Files". */
    function nameFromFile(path) {
        var base = path.split('/').pop();
        var stem = base.replace(/\.[^.]*$/, '') || base;
        return stem.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+$/, '').slice(0, 32);
    }

    /** Under "Add volume", fill an empty name from the chosen file. A typed name is never replaced. */
    function suggestName() {
        if (editing) { return; }
        var name = $.trim($('#e-name').val());
        if (name !== '' && name !== autoName) { return; }
        autoName = nameFromFile($.trim($('#e-file').val()));
        $('#e-name').val(autoName);
    }

    var autoOnceName = '';       // the name last filled in for "Mount a file once"

    /** The same for "Mount a file once": fill an empty name from the chosen file. */
    function suggestOnceName() {
        var name = $.trim($('#vcm-name').val());
        if (name !== '' && name !== autoOnceName) { return; }
        autoOnceName = nameFromFile($.trim($('#vcm-file').val()));
        $('#vcm-name').val(autoOnceName);
    }

    /** Load the saved settings and the choices, then show the panel for one volume. */
    function openEdit(name) {
        $.when(act({ action: 'config' }), options ? options : act({ action: 'options' })).then(function (c, o) {
            if (!c.ok) {
                message('Could not read the settings', esc(c.error), 'error');
                return;
            }
            config = c;
            options = o && o.ok ? o : { ok: true, users: [], containers: [] };
            editing = name || '';
            var v = { name: '', file: '' };
            config.volumes.forEach(function (x) { if (x.name === name) { v = x; } });
            if (name && v.name !== name) {
                message('No such volume', 'There is no saved volume called "' + esc(name) + '".', 'warning');
                return;
            }

            setCrumb(editing ? 'Edit volume ' + editing : 'Add volume');
            $('#e-name').val(v.name);
            $('#e-file').val(v.file);
            $('#e-display').val(v.display_name || '');
            $('#e-ro').prop('checked', !!v.read_only);
            var own = !v.mount_at || v.mount_at === '/mnt/addons/' + v.name;
            $('#e-mount-mode').val(own ? 'own' : 'share');
            $('#e-mount-at').val(own ? '' : v.mount_at);

            $('#e-share').val(v.share ? 'yes' : 'no');
            $('#e-export').val(v.share && v.share.export === 'hidden' ? 'hidden' : 'yes');
            var given = v.share ? v.share.users : {};
            var users = (options.users || []).slice();
            Object.keys(given).forEach(function (u) { if (users.indexOf(u) < 0) { users.push(u); } });
            $('#e-users').html(users.length
                ? users.map(function (u) { return userRow(u, given[u] || 'none'); }).join('')
                : '<tr><td colspan="2" class="vcm-empty">There are no Unraid users. Add one under Users first.</td></tr>');

            $('#e-deps').empty();
            (v.dependents || []).forEach(function (d) { $('#e-deps').append(depItem(d)); });
            depChoices();

            $('#e-remove, #e-apply').toggle(!!editing);
            $('#e-add').toggle(!editing);
            autoName = '';
            editError('');
            markClean();
            toggleFields();
            $('#vcm-list').hide();
            $('#vcm-edit').prop('hidden', false);
            $('#e-name').trigger('focus');
        });
    }

    function closeEdit() {
        $('#vcm-edit').prop('hidden', true);
        clearCrumb();
        $('#vcm-list').show();
        editing = null;
        dirty = false;
        refresh();
    }

    /** The volume as the form describes it, in the format of the settings file. */
    function collect() {
        var name = $.trim($('#e-name').val());
        var v = { name: name, file: $.trim($('#e-file').val()) };
        var display = $.trim($('#e-display').val());
        if (display && display !== name) { v.display_name = display; }
        if ($('#e-mount-mode').val() === 'share') { v.mount_at = $.trim($('#e-mount-at').val()); }
        if ($('#e-ro').is(':checked')) { v.read_only = true; }
        // Not editable yet, but kept as it was.
        config.volumes.forEach(function (x) { if (x.name === editing && x.hidden) { v.hidden = true; } });
        if ($('#e-share').val() === 'yes') {
            var users = {};
            $('.e-access').each(function () {
                if ($(this).val() !== 'none') { users[$(this).attr('data-user')] = $(this).val(); }
            });
            v.share = { export: $('#e-export').val(), users: users };
        }
        var deps = $('#e-deps li').map(function () {
            return {
                container: $(this).attr('data-container'),
                grace: parseInt($(this).find('.e-grace').val(), 10),
                delay: parseInt($(this).find('.e-delay').val(), 10)
            };
        }).get();
        if (deps.length) { v.dependents = deps; }
        return v;
    }

    /** First checks in the browser. The engine checks everything again (Decision U1). */
    function check(v) {
        if (!NAME.test(v.name)) { return 'The name may contain only letters, digits, - and _, at most 32 characters.'; }
        if (v.file.charAt(0) !== '/') { return 'Choose the volume file: its path starts with /.'; }
        var taken = config.volumes.some(function (x) { return x.name === v.name && x.name !== editing; });
        if (taken) { return 'Another volume already has the name "' + v.name + '".'; }
        if (v.mount_at !== undefined && v.mount_at.indexOf('/mnt/user/') !== 0) {
            return 'Choose a folder inside a share: its path starts with /mnt/user/.';
        }
        if (v.share && !Object.keys(v.share.users).length) { return 'Give at least one user access to the share, or turn sharing off.'; }
        var bad = (v.dependents || []).some(function (d) {
            return !(d.grace >= 1 && d.grace <= 600 && d.delay >= 0 && d.delay <= 600);
        });
        if (bad) { return 'Each dependent needs a stop time of 1 to 600 seconds and a wait of 0 to 600.'; }
        return '';
    }

    /** Save the whole list with this volume added, changed or removed. */
    function save(volumes, after) {
        var data = { action: 'save-config', revision: config.revision,
                     config: JSON.stringify({ settings: config.settings, volumes: volumes }) };
        $('#e-add, #e-apply, #e-done, #e-remove').prop('disabled', true);
        act(data).then(function (a) {
            $('#e-add, #e-apply, #e-done, #e-remove').prop('disabled', false);
            if (!a.ok) {
                editError(a.error || 'The settings could not be saved.');
                return;
            }
            config.revision = a.revision;
            config.volumes = volumes;
            markClean();
            checkPrivacy();
            editError('');
            after();
        });
    }

    function apply(back) {
        var v = collect();
        var problem = check(v);
        if (problem) { editError(problem); return; }
        var volumes = [];
        var replaced = false;
        config.volumes.forEach(function (x) {
            if (x.name === editing) { volumes.push(v); replaced = true; } else { volumes.push(x); }
        });
        if (!replaced) { volumes.push(v); }
        save(volumes, function () {
            if (back) { closeEdit(); return; }
            editing = v.name;
            setCrumb('Edit volume ' + v.name);
        });
    }

    function done() {
        if (!dirty) { closeEdit(); return; }
        swal({
            title: 'Discard your changes?', text: 'They have not been saved. Use ' + (editing ? 'Apply' : 'Add Volume') + ' to save them.',
            type: 'warning', showCancelButton: true, confirmButtonText: 'Discard'
        }, closeEdit);
    }

    function remove() {
        var name = editing;
        swal({
            title: 'Remove ' + esc(name) + ' from the list?',
            text: 'Only the entry is removed. The volume file itself is not touched.',
            type: 'warning', html: true, showCancelButton: true, confirmButtonText: 'Remove'
        }, function () {
            save(config.volumes.filter(function (x) { return x.name !== name; }), closeEdit);
        });
    }

    // ---- Start ------------------------------------------------------------

    $(function () {
        // The password form first (review H1): it must never be left to the browser.
        $('#vcm-mount-form').on('submit', submitMount);
        $('#vcm-http-warning').prop('hidden', !overHttp);

        // The list and the dialogs.
        $('#vcm-rows').on('click', '.vcm-mount', function () { stopQueue(); openDialog($(this).attr('data-name')); });
        $('#vcm-rows').on('click', '.vcm-dismount', function () {
            var name = $(this).attr('data-name');
            if ($(this).is('i') || $('#vcm-rows').is('[data-compact], [data-main]')) { confirmDismount(name); } else { dismount(name); }
        });
        // The tile's locks show what a click would do: under the mouse (or with
        // the keyboard on it) a closed lock opens and an open one closes.
        $('#vcm-rows').on('mouseenter mouseleave focusin focusout', '.vcm-tile-icon[role=button]', function (e) {
            var preview = e.type === 'mouseenter' || e.type === 'focusin';
            var open = $(this).hasClass('vcm-mount') ? preview : !preview;
            // The class is swapped in place: Unraid's icon styles look at how the
            // class list starts, so moving the class to the end shifts the icon.
            this.className = this.className.replace(/icon-u-lock(-open)?/, open ? 'icon-u-lock-open' : 'icon-u-lock');
        });
        $('#vcm-rows').on('keydown', 'i[role=button]', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
        });
        $('#vcm-rows').on('click', '.vcm-edit', function () { openEdit($(this).attr('data-name')); });
        $('#vcm-rows').on('click', '.vcm-info', function (e) { e.preventDefault(); showInfo($(this).attr('data-name')); });
        $('#vcm-add').on('click', function () { openEdit(''); });
        $('#vcm-mount-all').on('click', mountAll);
        $('#vcm-once').on('click', function () { stopQueue(); openDialog(null); });
        $('#vcm-dismount-all').on('click', dismountAll);
        $('#vcm-cancel').on('click', function () { stopQueue(); closeDialog(); refresh(); });
        $('#vcm-skip').on('click', function () { closeDialog(); nextInQueue(); });
        $(document).on('keydown', function (e) {
            if (e.key === 'Escape' && !$('#vcm-modal').prop('hidden')) { $('#vcm-cancel').trigger('click'); }
        });

        // The edit panel.
        $('#vcm-edit-form').on('input change', function (e) {
            if (e.target.id === 'e-file') { suggestName(); }
            markDirty();
            toggleFields();
        });
        $('#e-dep-add').on('click', function () {
            var container = $('#e-dep-choice').val();
            if (!container) { return; }
            $('#e-deps').append(depItem({ container: container, grace: 60, delay: 0 }));
            depChoices();
            markDirty();
            updateSummaries();
        });
        $('#e-deps').on('click', '.vcm-dep-remove', function (e) {
            e.preventDefault();
            $(this).closest('li').remove();
            depChoices();
            markDirty();
            updateSummaries();
        });
        // Drag and drop as on Unraid's own Docker page (jQuery UI, loaded by Unraid).
        if ($.fn.sortable) {
            // As on Unraid's Docker page: a copy follows the mouse and the row's
            // place keeps its full size, so nothing below it jumps. The mouse
            // position, not the overlap, decides where it lands, so the first
            // and last places are easy to reach even inside the list's bounds.
            $('#e-deps').sortable({
                handle: '.vcm-handle', axis: 'y', containment: 'parent', cursor: 'grab', opacity: 0.6,
                helper: 'clone', forcePlaceholderSize: true, placeholder: 'vcm-dep vcm-dep-gap',
                tolerance: 'pointer', delay: 100,
                update: function () { markDirty(); updateSummaries(); }
            });
        }
        // Unraid's own file browser for the two path fields.
        if ($.fn.fileTreeAttach) {
            $('#e-file').fileTreeAttach();
            $('#e-mount-at').fileTreeAttach();
            $('#vcm-file').fileTreeAttach();   // "Mount a file once" (Volumes tab only)
        }
        // "Mount a file once": fill an empty name from the chosen file, as "Add volume" does.
        $('#vcm-file').on('input change', suggestOnceName);
        $('#e-add').on('click', function () { apply(true); });
        $('#e-apply').on('click', function () { apply(false); });
        // Reset brings back the saved settings and stays, as Unraid's reload does.
        $('#e-done').on('click', function () { if (dirty) { openEdit(editing); } else { done(); } });
        $(document).on('click', '.vcm-crumb-back', function (e) { e.preventDefault(); done(); });
        $('#e-remove').on('click', remove);

        // A link such as the Dashboard tile's can ask for one volume's Edit screen.
        var wanted = new URLSearchParams(window.location.search).get('edit');
        if (wanted && NAME.test(wanted) && $('#vcm-edit').length) { openEdit(wanted); }

        // PRIV-3: ask once when the page opens, and again when the tab comes back
        // (the user may just have added the lines in File Activity).
        $('#vcm-privacy-copy').on('click', copyPrivacyLines);
        checkPrivacy();
        document.addEventListener('visibilitychange', function () { if (!document.hidden) { checkPrivacy(); } });

        // Put shares in order once, quietly (U4), then show the list. The list
        // is not refreshed while the edit panel is open.
        act({ action: 'repair-shares' }).always(refresh);
        setInterval(function () { if (editing === null) { refresh(); } }, REFRESH);
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && editing === null) { refresh(); }
        });
    });
}(jQuery));

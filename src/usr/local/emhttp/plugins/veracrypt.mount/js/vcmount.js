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
    // Patterns and limits matching scripts/vcmount and include/actions.php (audit B17.1).
    var NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
    var PIM = /^[1-9][0-9]{0,8}$/;
    var MAX_PASSWORD = 128;      // bytes, VeraCrypt's own limit
    var MAX_KEYFILES = 8;
    var RESERVED_SHARES = ['global', 'homes', 'printers', 'print$', 'ipc$'];
    var overHttp = window.location.protocol === 'http:';
    var httpsRequired = null;    // the setting "require HTTPS", from the list; null = not known yet

    var lastVolumes = [];        // the list as last shown
    var server = null;           // the server's network name and HTTPS port, from the list
    var lastTile = null;         // the tile's list as last drawn, to leave it alone when nothing changed
    var mountTarget = null;      // the volume the dialog is for; null = mount once
    var mounting = false;        // a mount request is on its way; a second click is ignored
    var cancelling = false;      // Cancel was clicked during an unlock; waiting for the answer
    var currentUnlockId = '';    // opaque token tying Cancel to this one unlock (review C3)
    var otherUnlockId = '';      // opaque token of another running unlock, for "Stop that unlock"
    var modalOpener = null;      // control to return focus to when #vcm-modal closes (audit B16.10)
    var infoOpener = null;       // control to return focus to when #vcm-info closes (audit B16.10)
    var pimWarned = false;       // the large-PIM warning was shown; the next click mounts
    var progressTimer = null;    // ticks the unlock progress once a second
    var UNLOCK_LIMIT = 180;      // seconds; the engine's UNLOCK_TIMEOUT
    var PIM_WARN = 2000;         // above this a PIM takes over four times VeraCrypt's default (485)
    var dismounting = Object.create(null);   // volumes this page is dismounting now: shown busy, a second click is ignored
    var mountQueue = [];         // the volumes "Mount all" still has to ask for
    var inQueue = false;         // the dialog is part of "Mount all"

    var config = null;           // the saved settings as "vcmount config" returns them
    var options = null;          // users and containers for the forms, read again for each edit (audit B9)
    // Each click on Edit, Info or Mount (over HTTP) counts up; an answer for an
    // older click is dropped, so a slow one cannot overwrite a newer (audit B10).
    var editSeq = 0, infoSeq = 0, dialogSeq = 0;
    var editing = null;          // the volume being edited: its saved name, '' for a new one, null = list shown
    var dirty = false;           // the edit panel has changes that are not saved
    var autoName = '';           // the name last filled in from the file name

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /** UTF-8 byte length, matching PHP's strlen() (audit B13, B17.1). */
    function utf8Bytes(s) {
        return window.TextEncoder ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length;
    }

    /** Plain path below /mnt/, mirroring plain_mnt_path() in scripts/vcmount (audit B17.1). */
    function plainMntPath(path) {
        return path.indexOf('/mnt/') === 0 && utf8Bytes(path) <= 4096
            && path.charAt(path.length - 1) !== '/' && path.indexOf('//') < 0
            && !/\/\.\.?(\/|$)/.test(path) && !/[\x00-\x1f\x7f]/.test(path);
    }

    /** Mirror of same_file() in scripts/vcmount: /mnt/user/<share>/x and /mnt/<disk>/<share>/x match. */
    function sameFile(one, two) {
        if (one === two) { return true; }
        var a = /^\/mnt\/([^/]+)\/(.+)$/.exec(one);
        var b = /^\/mnt\/([^/]+)\/(.+)$/.exec(two);
        if (!a || !b) { return false; }
        var viaUser = a[1] === 'user' || a[1] === 'user0' || b[1] === 'user' || b[1] === 'user0';
        return viaUser && a[2] === b[2];
    }

    /** Mirror of valid_mount_at() in scripts/vcmount for a folder inside a share (MNT-2). */
    function validShareMountAt(path) {
        return plainMntPath(path) && !/[\\\%]/.test(path) && /^\/mnt\/user\/[^/]+\/[^/]+/.test(path)
            && !/(^|\/)\s|\s(\/|$)/.test(path);
    }

    /** Whole non-negative integer, or NaN for decimals and non-digits. */
    function wholeInt(val) {
        var s = $.trim(String(val === null || val === undefined ? '' : val));
        return /^\d+$/.test(s) ? Number(s) : NaN;
    }

    /** Opaque 32-hex-character token tying a cancel to this one unlock (review C3). */
    function makeUnlockId() {
        var bytes = new Uint8Array(16);
        if (window.crypto && window.crypto.getRandomValues) {
            window.crypto.getRandomValues(bytes);
        } else {
            for (var i = 0; i < bytes.length; i++) { bytes[i] = Math.floor(Math.random() * 256); }
        }
        return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }

    /** Visible, enabled elements inside an open dialog that Tab can reach (audit B16.10). */
    function focusables(dialog) {
        return dialog.find('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]')
            .filter(function () {
                if (this.disabled || this.tabIndex < 0) { return false; }
                return $(this).is(':visible') && !$(this).hasClass('vcm-offscreen');
            });
    }

    /** Keep Tab and Shift+Tab cycling inside an open dialog (audit B16.10). */
    function trapTab(e, dialog) {
        if (e.key !== 'Tab' || dialog.prop('hidden')) { return; }
        if ($('.sweet-alert.visible').length) { return; }
        var list = focusables(dialog);
        if (!list.length) { e.preventDefault(); return; }
        var first = list[0], last = list[list.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first || !dialog[0].contains(document.activeElement)) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (document.activeElement === last || !dialog[0].contains(document.activeElement)) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    /** Remember the control that opened a dialog, with a fallback if its row redraws. */
    function captureOpener(el, kind, name) {
        var node = el || (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
        return { el: node, kind: kind, name: name, tag: node ? node.tagName : '' };
    }

    /** Return keyboard focus to the control that opened a dialog (audit B16.10). */
    function restoreFocus(opener) {
        if (!opener) { return; }
        if (opener.el && document.contains(opener.el) && $(opener.el).is(':visible')) {
            opener.el.focus();
            return;
        }
        var fallback = null;
        if (opener.kind === 'once') {
            fallback = $('#vcm-once:visible')[0];
        } else if (opener.kind === 'all') {
            fallback = $('#vcm-mount-all:visible')[0];
        } else if (opener.kind === 'info' && opener.name) {
            fallback = $('#vcm-rows .vcm-info:visible').filter(function () {
                return $(this).attr('data-name') === opener.name;
            }).first()[0];
        } else if (opener.kind === 'mount' && opener.name) {
            var sel = opener.tag === 'I'
                ? '#vcm-rows i.vcm-tile-icon[role=button]:visible'
                : '#vcm-rows input.vcm-mount:visible, #vcm-rows input.vcm-dismount:visible';
            fallback = $(sel).filter(function () {
                return $(this).attr('data-name') === opener.name;
            }).first()[0];
        }
        if (fallback) { fallback.focus(); }
    }

    /** Send one action. Always resolves, with the engine's answer or an error. */
    function act(data) {
        data.csrf_token = csrf_token;
        return $.ajax({ url: URL, method: 'POST', data: data, dataType: 'json', timeout: 330000 })
            .then(function (answer) { return answer; },
                  function () { return { ok: false, code: 1, lost: true, error: 'No answer from the server.' }; });
    }

    /** Whether size and free space are both known for this mounted volume. */
    function hasUsage(v) {
        return v.state === 'mounted' && v.size_bytes > 0 && v.free_bytes !== null && v.free_bytes !== undefined;
    }

    /** The server's network name for share paths (audit 2026-11-27c B7). */
    function smbName() {
        return ((server && server.name) || window.location.hostname).toUpperCase();
    }

    /** Used space in percent, kept between 0 and 100 (audit B16). */
    function usedPercent(v) {
        var p = Math.round(100 * (v.size_bytes - v.free_bytes) / v.size_bytes);
        return Math.max(0, Math.min(100, p));
    }

    function size(bytes) {
        if (bytes === null || bytes === undefined) { return '-'; }
        if (bytes < 1e9) { return Math.round(bytes / 1e6) + ' MB'; }
        return bytes < 1e12 ? (bytes / 1e9).toFixed(1) + ' GB' : (bytes / 1e12).toFixed(1) + ' TB';
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
            var path = '\\\\' + smbName() + '\\' + v.name;
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
            var state = tileState(v, orb) +
                        (v.read_only && v.state === 'mounted' ? ' <span class="vcm-ro" title="Mounted read-only">ro</span>' : '');
            var usage = '<span class="load">-</span><div class="usage-disk sys none"><span></span></div>';
            if (hasUsage(v)) {
                var percent = usedPercent(v);
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
        return '<a href="#" class="info hand vcm-info" data-name="' + esc(name) + '">' +
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
        var known = hasUsage(v);
        var sizes = '<td>-</td><td>-</td><td>-</td>';
        if (known) {
            var usedPart = usedPercent(v);
            sizes = '<td>' + size(v.size_bytes) + '</td>' +
                    '<td><div class="usage-disk"><span class="' + barClass(usedPart, false) + '" style="width:' + usedPart + '%"></span>' +
                    '<span>' + size(v.size_bytes - v.free_bytes) + '</span></div></td>' +
                    '<td><div class="usage-disk"><span class="' + barClass(100 - usedPart, true) + '" style="width:' + (100 - usedPart) + '%"></span>' +
                    '<span>' + size(v.free_bytes) + '</span></div></td>';
        }
        return '<tr>' +
            '<td>' + rowStart(v, label) + '</td>' +
            '<td>' + infoIcon(v.name) + esc(v.file || '-') + '</td>' +
            '<td colspan="3">' + esc(v.mounted_at || '-') + idleHint(v) + '</td>' +
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
            var path = '\\\\' + smbName() + '\\' + v.name;
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
        if (hasUsage(v)) {
            var used = usedPercent(v);
            return twoLines('<span class="vcm-bar"><span class="' + barClass(used, false) + '" style="width:' + used + '%"></span></span>' + used + '%',
                            size(v.free_bytes) + ' free of ' + size(v.size_bytes) + (v.filesystem ? ' · ' + esc(v.filesystem) : ''));
        }
        return twoLines('<span class="vcm-dim">-</span>', v.state === 'unlocked' ? 'unlocked, not mounted' : '');
    }

    /**
     * LIFE-8: how soon a mounted volume is locked when idle, as the last check
     * saw it. Long form for the Volumes tab and Main, short for the tile.
     */
    function idleText(v, short) {
        if (v.state !== 'mounted' || !v.idle_lock || v.locks_in === null || v.locks_in === undefined) { return ''; }
        if (v.idle_blocked) { return short ? 'held open' : 'idle, held open'; }
        if (v.locks_in <= 1) { return short ? '1m left' : 'locks soon'; }
        return short ? v.locks_in + 'm left' : 'locks in ' + v.locks_in + ' min';
    }

    function idleTitle(v) {
        return 'Locked after ' + v.idle_lock + ' minutes without reads or writes' +
               (v.idle_blocked ? '; something still holds it open' : '');
    }

    function idleHint(v) {
        var text = idleText(v, false);
        return text ? ' <span class="vcm-dim" title="' + esc(idleTitle(v)) + '">· ' + esc(text) + '</span>' : '';
    }

    /**
     * The tile's status: Unraid's dot and the state. Its column is narrow, so
     * while the idle lock counts down, an hourglass in the dot's place and
     * colour (orange when something holds the volume open) and the time left
     * stand for "mounted"; the full text is in the tooltip.
     */
    function tileState(v, orb) {
        var text = idleText(v, true);
        if (!text) {
            return '<i class="fa fa-circle orb ' + orb + '-orb middle"></i>' + esc(v.state);
        }
        return '<span class="vcm-idle" title="' + esc('Mounted, ' + idleText(v, false) + '. ' + idleTitle(v)) + '">' +
               '<i class="fa fa-hourglass-half orb ' + (v.idle_blocked ? 'yellow' : 'green') + '-orb middle"></i>' +
               esc(text) + '</span>';
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
                    (v.read_only && mountedNow ? ' <span class="vcm-ro" title="Mounted read-only">ro</span>' : '') +
                    idleHint(v);
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
                if (a.server) { server = a.server; }
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

    function closeInfo() {
        var box = $('#vcm-info');
        if (!box.length || box.prop('hidden')) { return; }
        box.prop('hidden', true);
        var opener = infoOpener;
        infoOpener = null;
        restoreFocus(opener);
    }

    /**
     * Show what "vcmount info" reports about one volume, read-only, in a window
     * in the style of the mount dialog. Built when first needed.
     */
    function showInfo(name, openerEl) {
        if (!$('#vcm-info').length || $('#vcm-info').prop('hidden')) {
            infoOpener = captureOpener(openerEl, 'info', name);
        }
        var seq = ++infoSeq;
        act({ action: 'info', name: name }).then(function (a) {
            if (seq !== infoSeq) { return; }
            if (!a.ok) {
                infoOpener = null;
                message('No information', esc(a.error || 'The volume could not be read.'), 'error');
                return;
            }
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
            if (hasUsage(v)) {   // audit 2026-11-27c B5
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
                box = $('<div id="vcm-info" class="vcm-modal" role="dialog" aria-modal="true" aria-labelledby="vcm-info-title" hidden>' +
                        '<div class="vcm-box vcm-info-box">' +
                        '<h3 id="vcm-info-title"></h3><div id="vcm-info-body"></div>' +
                        '<div class="vcm-buttons"><input type="button" id="vcm-info-close" value="Close"></div></div></div>').appendTo('body');
                box.on('click', function (e) { if (e.target === this) { closeInfo(); } });
                $('#vcm-info-close').on('click', closeInfo);
            }
            $('#vcm-info-body').off('click').on('click', '.vcm-fix-top', function (e) {
                e.preventDefault();
                var link = $(this);
                if (link.hasClass('vcm-busy')) { return; }   // a second click while the first runs
                link.addClass('vcm-busy');
                act({ action: 'fix-top', name: link.attr('data-name') }).then(function (f) {
                    link.removeClass('vcm-busy');
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
                    type: 'warning', html: true, showCancelButton: true, confirmButtonText: 'Fix permissions',
                    closeOnConfirm: false, showLoaderOnConfirm: true
                }, function (yes) {
                    if (!yes) { return; }   // audit 2026-11-27c B6
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

    /**
     * Over plain HTTP, ask the server for "Require HTTPS" now: the setting may
     * have changed on the Settings tab or in another browser tab since this
     * page last read it. Unknown counts as required.
     */
    function freshHttpsSetting(next) {
        act({ action: 'list' }).then(function (a) {
            httpsRequired = a.ok && a.settings ? !!a.settings.require_https : true;
            if (a.ok && Array.isArray(a.volumes)) { lastVolumes = a.volumes; }   // the newest list for the dialog
            next();
        });
    }

    function openDialog(name, checked, openerEl) {
        if (!checked && $('#vcm-modal').prop('hidden') && !(inQueue && modalOpener)) {
            modalOpener = captureOpener(openerEl, inQueue ? 'all' : (name === null ? 'once' : 'mount'), name);
        }
        busyWatch++;
        checkingHttp = 0;
        currentUnlockId = '';
        otherUnlockId = '';
        if (overHttp && !checked) {
            var seq = ++dialogSeq;
            freshHttpsSetting(function () { if (seq === dialogSeq) { openDialog(name, true); } });
            return;
        }
        var blocked = passwordBlocked();
        mountTarget = name;
        var once = name === null;
        // KEY-2: what this volume needs besides the password.
        var v = null;
        lastVolumes.forEach(function (x) { if (x.name === name) { v = x; } });
        // The name as the lists show it.
        $('#vcm-mount-title').text(once ? 'Mount a file once' : 'Mount ' + ((v && v.display_name) || name));
        $('#vcm-user').val(once ? '' : 'veracrypt:' + name);
        $('#vcm-password').val('').attr('autocomplete', once ? 'off' : 'current-password');
        var keyfiles = (v && v.keyfiles) || [];
        // Extras: for "Mount a file once" four boxes, each showing its field
        // when ticked; for a saved volume only its PIM field, if it has one.
        $('#vcm-name, #vcm-file').val('');
        $('#vcm-hidden, #vcm-read-only, #vcm-use-pim, #vcm-use-keyfiles').prop('checked', false);
        $('#vcm-opts .vcm-once-only').prop('hidden', !once);
        $('#vcm-opts .vcm-saved-only').prop('hidden', once);
        $('#vcm-opts').toggleClass('vcm-opts-saved', !once);
        $('#vcm-keyfiles-box').prop('hidden', true);
        $('#vcm-keyfiles').empty();
        if (once) { addKeyfileRow('', '#vcm-keyfiles'); }
        $('#vcm-pim').val('').prop('hidden', once);
        $('#vcm-opts').prop('hidden', blocked || !(once || (v && v.pim)));
        $('#vcm-once-note').prop('hidden', !once || blocked);
        $('#vcm-keyfile-note').prop('hidden', blocked || !keyfiles.length)
            .text((keyfiles.length > 1 ? 'Keyfiles: ' : 'Keyfile: ') + keyfiles.join(', ') +
                  '. Leave the password empty if the volume has none.' +
                  (v && v.hidden ? ' Opens the hidden volume.' : ''));
        $('#vcm-mount-error').prop('hidden', true).text('');
        $('#vcm-dialog-http').prop('hidden', !overHttp || blocked);
        $('#vcm-dialog-https').prop('hidden', !blocked);
        // The host name with Unraid's own HTTPS port, never the HTTP one
        // (audit B16, 2026-11-27c B7).
        var port = server && server.https_port && server.https_port !== 443 ? ':' + server.https_port : '';
        $('#vcm-https-link').attr('href', 'https://' + window.location.hostname + port + window.location.pathname + window.location.search);
        $('#vcm-password-label').prop('hidden', blocked);
        $('#vcm-mount-submit').toggle(!blocked);
        $('#vcm-once-fields').prop('hidden', !once || blocked);
        $('#vcm-password').prop('disabled', blocked);
        $('#vcm-skip').prop('hidden', !inQueue);
        $('#vcm-mount-submit').prop('disabled', blocked).val('Mount');
        $('#vcm-skip').prop('disabled', false);
        pimWarned = false;
        $('#vcm-pim-warn, #vcm-stop-other').prop('hidden', true);
        stopProgress();
        $('#vcm-modal').prop('hidden', false);
        $(blocked ? '#vcm-cancel' : (once ? '#vcm-file' : '#vcm-password')).trigger('focus');
    }

    function closeDialog(keepOpener) {
        if (!mounting) { busyWatch++; }
        if (mounting) { return; }   // not while a mount is on its way
        currentUnlockId = '';
        otherUnlockId = '';
        $('#vcm-password, #vcm-pim').val('');
        // "Mount a file once" leaves no trace in the page either (audit S10).
        $('#vcm-file, #vcm-name').val('');
        autoOnceName = '';
        $('#vcm-keyfiles').empty();
        $('#vcm-modal').prop('hidden', true);
        mountTarget = null;
        if (!keepOpener) {
            var opener = modalOpener;
            modalOpener = null;
            restoreFocus(opener);
        }
    }

    /** "Mount all" (VOL-6): ask for the next volume in the queue, or finish. */
    function nextInQueue() {
        if (mountQueue.length) {
            inQueue = true;
            openDialog(mountQueue.shift());
        } else {
            inQueue = false;
            var opener = modalOpener;
            modalOpener = null;
            restoreFocus(opener);
            refresh();
        }
    }

    function stopQueue() {
        mountQueue = [];
        inQueue = false;
    }

    function mountAll(openerEl) {
        mountQueue = lastVolumes.filter(function (v) { return v.saved && v.state === 'locked'; })
                                .map(function (v) { return v.name; });
        if (!mountQueue.length) {
            message('Nothing to mount', 'Every saved volume is already mounted.', 'info');
            return;
        }
        modalOpener = captureOpener(openerEl, 'all', null);
        nextInQueue();
    }

    /** Show how long unlocking has taken, against the engine's time limit. */
    function startProgress(withPim) {
        var start = Date.now();
        $('#vcm-progress-text').text('Checking the password…');
        $('#vcm-progress-note').text('This is slow on purpose: it makes guessing passwords slow too.'
            + (withPim ? ' A PIM makes it slower still.' : '') + ' Cancel stops it; so does a limit of 3 minutes.');
        $('#vcm-progress-fill').css('width', '0');
        $('#vcm-progress').prop('hidden', false);
        var tick = function () {
            var s = Math.floor((Date.now() - start) / 1000);
            $('#vcm-progress-time').text(clock(s));
            $('#vcm-progress-fill').css('width', Math.min(100, s / UNLOCK_LIMIT * 100) + '%');
            if (s >= UNLOCK_LIMIT) { $('#vcm-progress-text').text('Taking too long, stopping…'); }
        };
        tick();
        progressTimer = setInterval(tick, 1000);
    }

    function stopProgress() {
        if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        $('#vcm-progress').prop('hidden', true);
        cancelling = false;
        $('#vcm-cancel').prop('disabled', false).val('Cancel');
    }

    /**
     * Cancel during an unlock (UI-8): ask the engine to stop. The mount request
     * that is still on its way then answers "Unlocking was cancelled", or, if the
     * password was already accepted, that the volume is mounted.
     */
    function cancelUnlock() {
        if (cancelling) { return; }
        cancelling = true;
        stopQueue();
        $('#vcm-cancel').prop('disabled', true).val('Cancelling…');
        $('#vcm-progress-text').text('Cancelling…');
        act(currentUnlockId ? { action: 'cancel-unlock', unlock_id: currentUnlockId } : { action: 'cancel-unlock' });
    }

    function clock(s) {
        return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }

    /**
     * The engine was busy with another action, so nothing was done. Say what is
     * running; if it is another unlock, offer to stop it (UI-8).
     */
    var busyWatch = 0;   // counts up whenever the dialog changes; an old watch then stops

    /**
     * After a "busy" answer, keep checking quietly (review C2). The busy action
     * may have been this very mount: a browser can send a request twice, and
     * the copy is the one that answers "busy". If this volume ends up mounted,
     * say so; otherwise say when the other action is over.
     */
    function watchBusy(name) {
        var id = ++busyWatch;
        var tries = 0;
        (function poll() {
            setTimeout(function () {
                if (id !== busyWatch) { return; }
                act({ action: 'busy' }).then(function (b) {
                    if (id !== busyWatch) { return; }
                    if ((!b.ok || b.busy) && ++tries < 150) { poll(); return; }
                    act({ action: 'status', name: name }).then(function (s) {
                        if (id !== busyWatch) { return; }
                        $('#vcm-stop-other').prop('hidden', true);
                        if (s.ok && s.volume && s.volume.state === 'mounted') {
                            mounted(s);
                        } else {
                            dialogError('The other action is over. Enter the password and click Mount.');
                        }
                    });
                });
            }, 2000);
        })();
    }

    function otherBusy(name) {
        // Nothing of this mount runs any more, so Cancel only closes the dialog
        // from now on, and an answer for a dialog closed meanwhile is dropped
        // (audit B8).
        mounting = false;
        currentUnlockId = '';
        otherUnlockId = '';
        stopProgress();
        $('#vcm-mount-submit').val('Checking…');
        watchBusy(name);
        var id = busyWatch;
        act({ action: 'busy' }).then(function (b) {
            if (id !== busyWatch) { return; }
            if (b.ok && b.busy && b.unlocking_for !== null && b.unlocking_for !== undefined) {
                otherUnlockId = b.unlock_id || '';
                var left = Math.max(0, UNLOCK_LIMIT + 5 - b.unlocking_for);
                dialogError('Another volume is still being unlocked (for ' + clock(b.unlocking_for)
                    + '; it stops by itself within about ' + clock(left) + '), so nothing was done. '
                    + 'Wait for it, or stop it and try again.');
                $('#vcm-stop-other').prop('disabled', false).val('Stop that unlock').prop('hidden', false);
            } else if (b.ok && b.busy) {
                dialogError('Another action is still running, for example a dismount, so nothing was done. '
                    + 'Please try again in a moment.');
            } else if (!b.ok) {
                dialogError('Another action was running, so nothing was done. Please try again.');
            } else {
                dialogError('Another action was running and has just finished. Please try again.');
            }
        });
    }

    function stopOther() {
        var id = ++busyWatch;   // this answer replaces the quiet check (audit B4)
        var target = otherUnlockId;
        otherUnlockId = '';
        $('#vcm-stop-other').prop('disabled', true).val('Stopping…');
        act(target ? { action: 'cancel-unlock', unlock_id: target } : { action: 'cancel-unlock' }).then(function () {
            if (id !== busyWatch) { return; }
            var tries = 0;
            (function poll() {
                act({ action: 'busy' }).then(function (b) {
                    if (id !== busyWatch) { return; }
                    if (b.ok && b.busy && ++tries < 10) { setTimeout(poll, 500); return; }
                    $('#vcm-stop-other').prop('hidden', true);
                    dialogError(b.ok && !b.busy
                        ? 'The other unlock was stopped. Enter the password and click Mount.'
                        : 'The other action is still running. Please try again in a moment.');
                });
            })();
        });
    }

    function dialogError(text) {
        mounting = false;
        currentUnlockId = '';
        stopProgress();
        $('#vcm-mount-error').text(text).prop('hidden', false);
        $('#vcm-mount-submit').prop('disabled', false).val('Mount');
        $('#vcm-skip').prop('disabled', false);
    }

    function mounted(a) {
        // Cancel was clicked, but the password had already been accepted: the
        // mount went ahead, as designed (UI-8). Say so instead of staying quiet.
        var late = cancelling;
        mounting = false;
        currentUnlockId = '';
        stopProgress();
        closeDialog(inQueue && mountQueue.length > 0);
        var notes = [];
        if (late) {
            notes.push('The password had already been accepted when Cancel arrived, so "' + esc(mountLabel)
                + '" is mounted. Dismount it if you did not want it.');
        }
        if (a.share_error) { notes.push(esc(a.share_error)); }
        (a.failed_dependents || []).forEach(function (f) {
            notes.push('Dependent ' + esc(f.container) + ' could not be started: ' + esc(f.reason));
        });
        if (notes.length) {
            var problems = notes.length > (late ? 1 : 0);
            message(late ? 'Mounted anyway' : 'Mounted, with problems', notes.join('<br><br>'), problems ? 'warning' : 'info');
        }
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
        var path = '\\\\' + smbName() + '\\' + v.name;
        swal({
            title: 'Allow writing over the network?',
            text: 'The share ' + esc(path) + ' gives ' + esc(writers.join(', ')) + ' write access, but the top folder of ' +
                  esc(v.display_name) + ' belongs to another user, so the share cannot write to it.<br><br>' +
                  'Set the top folder to owner nobody:users and make it writable? Nothing inside the volume is changed.',
            type: 'info', html: true, showCancelButton: true,
            confirmButtonText: 'Set it', cancelButtonText: 'Not now', closeOnConfirm: false, showLoaderOnConfirm: true
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
        // After a server timeout the engine was already stopped, so Cancel
        // only closes the dialog instead of sending a stray cancel-unlock (audit B4).
        if (lost === 'timeout') {
            mounting = false;
            currentUnlockId = '';
            stopProgress();
        }
        $('#vcm-mount-submit').val('Checking…');
        var id = ++busyWatch;
        var tries = 0;
        (function poll() {
            act({ action: 'busy' }).then(function (b) {
                if (id !== busyWatch) { return; }
                if ((!b.ok || b.busy) && ++tries < 120) {
                    setTimeout(poll, 2000);
                    return;
                }
                act({ action: 'status', name: name }).then(function (s) {
                    if (id !== busyWatch) { return; }
                    if (s.ok && s.volume && s.volume.state === 'mounted') {
                        // The status carries the same warnings a mount answer
                        // would (share, dependents, top folder; audit B8).
                        mounted(s);
                    } else if (lost === 'timeout') {
                        dialogError('The engine took too long and was stopped; the volume is not mounted. '
                            + 'Please try again.');
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

    var mountLabel = '';       // the name of the volume being mounted, for messages
    var httpChecked = false;   // the setting was asked for right before this send
    var checkingHttp = 0;      // a pending pre-send check; Cancel drops it (audit S4)
    var httpCheckSeq = 0;

    function submitMount(event) {
        if (event) { event.preventDefault(); }
        if (mounting || checkingHttp || passwordBlocked()) { return; }   // never send a password the setting forbids
        // Over plain HTTP, ask once more right before the password leaves the
        // browser; if the setting is on now, show the HTTPS notice instead.
        // Cancel during this check drops it, and nothing is sent.
        if (overHttp && !httpChecked) {
            var id = checkingHttp = ++httpCheckSeq;
            $('#vcm-mount-submit').prop('disabled', true);
            $('#vcm-skip').prop('disabled', true);
            freshHttpsSetting(function () {
                if (checkingHttp !== id) { return; }
                checkingHttp = 0;
                $('#vcm-mount-submit').prop('disabled', false);
                if (passwordBlocked()) {
                    $('#vcm-password, #vcm-pim').val('');
                    openDialog(mountTarget, true);
                    return;
                }
                httpChecked = true;
                submitMount(null);
            });
            return;
        }
        httpChecked = false;
        var once = mountTarget === null;
        var field = $('#vcm-password');
        var pimField = $('#vcm-pim');
        var v = null;
        lastVolumes.forEach(function (x) { if (x.name === mountTarget) { v = x; } });
        var data = { action: once ? 'mount-once' : 'mount', name: once ? $.trim($('#vcm-name').val()) : mountTarget };
        var keyfile = false;
        if (once) {
            data.file = $.trim($('#vcm-file').val());
            data.read_only = $('#vcm-read-only').is(':checked') ? '1' : '0';
            data.hidden = $('#vcm-hidden').is(':checked') ? '1' : '0';
            // Mirror the engine's rules before reading or clearing the password (audit B17.1).
            if (!plainMntPath(data.file)) {
                dialogError('Choose a valid volume file path under /mnt/ (no trailing /, ".." or control characters).');
                $('#vcm-file').trigger('focus');
                return;
            }
            if (!NAME.test(data.name)) {
                dialogError('Enter a name: letters, digits, - and _, starting with a letter or digit.');
                $('#vcm-name').trigger('focus');
                return;
            }
            if ($('#vcm-use-keyfiles').is(':checked')) {
                var ks = keyfilePaths('#vcm-keyfiles');
                if (!ks.length) { dialogError('Choose a keyfile, or untick "Use keyfiles".'); return; }
                if (ks.length > MAX_KEYFILES) { dialogError('Too many keyfiles.'); return; }
                if (ks.some(function (k) { return !plainMntPath(k); })) {
                    dialogError('A keyfile must be a plain file path under /mnt/.');
                    return;
                }
                if (ks.some(function (k) { return sameFile(k, data.file); })) {
                    dialogError('The volume file cannot be its own keyfile.');
                    return;
                }
                data.keyfiles = ks;
                keyfile = true;
            }
        } else {
            keyfile = !!(v && v.keyfiles && v.keyfiles.length);
        }
        // The PIM counts only where it is asked for: its box for "Mount a file
        // once", the volume's setting otherwise.
        var needsPim = once ? $('#vcm-use-pim').is(':checked') : !!(v && v.pim);
        var pim = needsPim ? $.trim(pimField.val()) : '';
        var pw = field.val();
        if (pw === '' && !keyfile) { pw = null; dialogError('Enter the password.'); field.trigger('focus'); return; }
        if (/[\0\r\n]/.test(pw)) { pw = null; dialogError('The password contains a line break.'); field.trigger('focus'); return; }
        if (utf8Bytes(pw) > MAX_PASSWORD) {
            pw = null;
            dialogError('The password is longer than VeraCrypt allows (' + MAX_PASSWORD
                + ' bytes; letters such as \u00fc count twice, emoji four times).');
            field.trigger('focus');
            return;
        }
        if (needsPim && pim === '') { pw = null; dialogError('Enter the PIM.'); pimField.trigger('focus'); return; }
        if (pim !== '' && !PIM.test(pim)) {
            pw = null;
            dialogError('The PIM must be a whole number from 1 upwards, without spaces.');
            pimField.trigger('focus');
            return;
        }
        // A typo such as 739184 for 739 would run into the time limit.
        if (pim !== '' && Number(pim) > PIM_WARN && !pimWarned) {
            pw = null;
            pimWarned = true;
            $('#vcm-mount-error').prop('hidden', true);
            $('#vcm-pim-warn').prop('hidden', false);
            $('#vcm-mount-submit').val('Mount anyway');
            pim = null;
            return;
        }
        $('#vcm-pim-warn, #vcm-stop-other').prop('hidden', true);
        var withPim = pim !== '';
        mounting = true;
        busyWatch++;
        currentUnlockId = makeUnlockId();
        data.unlock_id = currentUnlockId;
        data.password = pw;
        pw = null;
        data.no_password = data.password === '' ? '1' : '0';
        if (pim !== '') { data.pim = pim; }
        field.val('');
        pimField.val('');
        pim = null;
        $('#vcm-mount-error').prop('hidden', true);
        mountLabel = once ? data.name : ((v && v.display_name) || mountTarget);
        $('#vcm-mount-submit').prop('disabled', true).val('Unlocking…');
        $('#vcm-skip').prop('disabled', true);   // not while it unlocks (audit 2026-11-27c B1)
        startProgress(withPim);

        var name = data.name;
        act(data).then(function (a) {
            if (a.ok) {
                mounted(a);
            } else if (a.lost || a.timed_out) {
                // Either way the volume may be mounted after all: look.
                settle(name, a.timed_out ? 'timeout' : 'lost');
            } else if (a.code === 6) {
                otherBusy(name);
            } else {
                dialogError(a.error || 'The volume could not be mounted.');
                field.trigger('focus');
            }
        });
        data.password = null;
        data.pim = null;
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

    /**
     * The notes worth showing. A dependent that stopped cleanly is what the
     * confirmation already announced, so it gets no popup; the command line
     * still lists it.
     */
    var CLEAN_STOP = /^Stopped dependent "/;
    function notesOf(a) {
        return (a.notes || []).filter(function (n) { return !CLEAN_STOP.test(n); }).map(esc).join('<br>');
    }

    function dismount(name) {
        if (dismounting[name]) { return; }
        setDismounting([name], true);
        act({ action: 'dismount', name: name }).then(function (a) {
            setDismounting([name], false);
            refresh();
            if (a.ok) {
                if (notesOf(a)) { message('Dismounted ' + esc(name), notesOf(a), 'info'); }
                return;
            }
            if (a.code !== 5) {
                message('Could not dismount', esc(a.error), 'error');
                return;
            }
            // Busy: nothing was forced. One dialog says what holds it, what
            // forcing ends, and offers it (LIFE-5), as VeraCrypt itself does.
            // Mounted inside a share (MNT-2): other containers given that
            // share, and the computers using it, are affected too (audit
            // 2026-11-27c S3).
            var vol = lastVolumes.filter(function (x) { return x.name === name; })[0];
            var inShare = !!(vol && vol.mount_at && vol.mount_at.indexOf('/mnt/user/') === 0);
            swal({
                title: esc(name) + ' is still in use',
                text: 'It stays mounted; nothing was forced.' + heldBy(a)
                    + (a.details && a.details.restored ? '<br>' + esc(a.details.restored) : '')
                    + '<br><br>Forcing ends these programs and stops containers that use the volume. Unsaved work in them is lost.'
                    + (inShare ? ' It is mounted inside a share, so this can also stop other containers that use that share,'
                        + ' and end the network connection of a computer that has a file open there.' : ''),
                type: 'warning', html: true,
                showCancelButton: true, confirmButtonText: 'Force dismount',
                closeOnConfirm: false, showLoaderOnConfirm: true
            }, function (yes) {
                if (!yes) { return; }
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
            // Enter or a stray click on the spot of the last button must not
            // force: the safe choice has the focus.
            setTimeout(function () { $('.sweet-alert.visible button.cancel').trigger('focus'); }, 50);
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
        }, function (yes) { if (yes) { dismount(name); } });
    }

    function dismountAll() {
        swal({
            title: 'Dismount all volumes?',
            text: 'Their dependents are stopped first. Nothing is forced.',
            type: 'warning', showCancelButton: true, confirmButtonText: 'Dismount all', closeOnConfirm: false
        }, function (yes) {
            if (!yes) { return; }
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
                    // A killed or failed dependent is reported here too.
                    return r.ok ? esc(r.message) + (notesOf(r) ? '<br>' + notesOf(r) : '') : esc(r.error) + heldBy(r);
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
        // DOC-7: marked on its row with the reason; #e-deps-alone explains.
        var alone = options.starts_alone && Object.prototype.hasOwnProperty.call(options.starts_alone, dep.container)
            ? options.starts_alone[dep.container] : null;
        var why = alone ? [alone.autostart ? 'autostart on' : '', alone.restart ? 'restart policy' : ''].filter(Boolean) : [];
        var whyLong = alone ? [alone.autostart ? 'Unraid autostart is on.' : '',
                               alone.restart ? 'Docker restart policy: ' + alone.restart + '.' : ''].filter(Boolean) : [];
        return $('<li class="vcm-dep">' +
            '<span class="vcm-handle" title="Drag to reorder">&#9776;</span>' +
            '<span class="vcm-dep-name">' + esc(dep.container) + (known ? '' : ' <em>(not found)</em>') + '</span>' +
            '<label>stop within <input type="number" class="e-grace" min="1" max="600" step="1" value="' + esc(dep.grace) + '"> s</label>' +
            '<label>then wait <input type="number" class="e-delay" min="0" max="600" step="1" value="' + esc(dep.delay) + '"> s</label>' +
            // Unraid's own warning mark, as on its Docker and Main pages.
            (why.length ? '<span class="vcm-dep-alone" title="' + esc(whyLong.join(' ')) +
                     '"><i class="fa fa-warning orange-text"></i> ' + esc(why.join(', ')) + '</span>' : '') +
            '<a href="#" class="vcm-dep-remove" title="Remove">&#10005;</a>' +
            '</li>').attr('data-container', dep.container);
    }

    // Keyfile lists: '#e-keyfiles' in the edit panel, '#vcm-keyfiles' in the
    // "Mount a file once" dialog. Each is followed by its "Add another" link.

    /** One keyfile field with Unraid's file picker and a remove link. */
    function addKeyfileRow(path, list) {
        list = list || '#e-keyfiles';
        var row = $('<div class="vcm-keyfile"><input type="text" class="e-keyfile" spellcheck="false" '
            + 'autocomplete="off" placeholder="/mnt/..." data-pickroot="/mnt/" data-pickcloseonfile="true">'
            + '<a href="#" class="vcm-keyfile-remove" title="Remove this keyfile">&#10005;</a>'
            + '<span class="vcm-note" hidden>Already listed above; counts once.</span></div>');
        row.find('input').val(path || '');
        $(list).append(row);
        if ($.fn.fileTreeAttach) { row.find('input').fileTreeAttach(); }
        keyfileRows(list);
        return row;
    }

    /** One field needs no remove link; the add link stops at the limit. */
    function keyfileRows(list) {
        list = list || '#e-keyfiles';
        var rows = $(list).find('.vcm-keyfile');
        rows.find('.vcm-keyfile-remove').prop('hidden', rows.length < 2);
        $(list).siblings('a').prop('hidden', rows.length >= MAX_KEYFILES);
        // A repeated path is saved once; say so under the repeat.
        var seen = [];
        rows.each(function () {
            var p = $.trim($(this).find('input').val());
            $(this).find('.vcm-note').prop('hidden', !p || seen.indexOf(p) < 0);
            if (p) { seen.push(p); }
        });
    }

    /** The edit panel's keyfiles: only while "Uses keyfiles" is ticked. */
    function editKeyfiles() {
        return $('#e-use-keyfiles').is(':checked') ? keyfilePaths('#e-keyfiles') : [];
    }

    /** The filled-in keyfile paths, without empty fields or repeats. */
    function keyfilePaths(list) {
        var paths = [];
        $(list || '#e-keyfiles').find('.e-keyfile').each(function () {
            var p = $.trim($(this).val());
            if (p && paths.indexOf(p) < 0) { paths.push(p); }
        });
        return paths;
    }

    function depChoices() {
        var used = $('#e-deps li').map(function () { return $(this).attr('data-container'); }).get();
        var free = (options.containers || []).filter(function (c) { return used.indexOf(c) < 0; });
        $('#e-dep-choice').html(free.length
            ? free.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('')
            : '<option value="">(no other containers)</option>');
    }

    /**
     * LIFE-3: at shutdown the dependents of all volumes get half of Unraid's
     * shutdown time-out. Warn when this volume's dependents alone need more.
     */
    function depsTime() {
        var total = 0;
        $('#e-deps .e-grace').each(function () { total += parseInt($(this).val(), 10) || 0; });
        // The other volumes' dependents share the same time (audit 2026-11-27c B4).
        var others = 0;
        (config && config.volumes || []).forEach(function (x) {
            if (x.name === editing) { return; }
            (x.dependents || []).forEach(function (d) { others += Number(d.grace) || 0; });
        });
        var budget = Math.max(20, Math.floor(((options && options.shutdown_timeout) || 90) / 2));
        $('#e-deps-time').prop('hidden', total === 0 || total + others <= budget).text(
            (others ? 'With the dependents of your other volumes, all dependents together may need '
                : 'Together these dependents may need ') + (total + others) + ' seconds to stop, but at shutdown or reboot '
            + 'there are only ' + budget + ' (half of Unraid\'s shutdown time-out, Settings › Disk Settings). '
            + 'The grace periods are then shortened to fit, and what still runs is stopped by Unraid with its '
            + 'own short limit. Shorten the grace periods, or raise the time-out.');
    }

    /**
     * DOC-7: a dependent that Unraid or Docker starts by itself can run before
     * its volume is mounted. Name each one and why.
     */
    function depsAlone() {
        $('#e-deps-alone').prop('hidden', !$('#e-deps .vcm-dep-alone').length).html(
            '<i class="fa fa-warning orange-text"></i> Marked dependents start on their own and can run before the volume is mounted. They then write into '
            + 'memory instead of the volume, and <b>the volume can\'t be mounted there afterwards</b>. On the Docker '
            + 'tab, switch off autostart and set the restart policy to "no" or "on-failure"; this plugin starts them '
            + 'after the mount.');
    }

    function updateSummaries() {
        depsTime();
        depsAlone();
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
        var unlock = ['password'];
        var kf = editKeyfiles().length;
        if (kf) { unlock.push(kf === 1 ? '1 keyfile' : kf + ' keyfiles'); }
        if ($('#e-pim').is(':checked')) { unlock.push('PIM'); }
        if ($('#e-ro').is(':checked')) { unlock.push('read-only'); }
        $('#s-unlock').text(unlock.join(', ') + ($('#e-hidden').is(':checked') ? ' · hidden volume' : '') +
                            ($('#e-idle').is(':checked') ? ' · locks after ' + $('#e-idle-min').val() + ' min idle' : ''));
        var deps = $('#e-deps li').map(function () { return $(this).attr('data-container'); }).get();
        $('#s-deps').text(deps.length ? deps.join(', ') : 'none');
        // Seen also while the section is closed (DOC-7).
        if ($('#e-deps .vcm-dep-alone').length) {
            $('#s-deps').prepend('<i class="fa fa-warning orange-text" title="A dependent starts on its own"></i> ');
        }
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
        $('#e-keyfiles-box').prop('hidden', !$('#e-use-keyfiles').is(':checked'));
        $('#e-idle-box').prop('hidden', !$('#e-idle').is(':checked'));
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
        var seq = ++editSeq;
        $.when(act({ action: 'config' }), act({ action: 'options' })).then(function (c, o) {
            if (seq !== editSeq) { return; }
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
            $('#e-pim').prop('checked', !!v.pim);
            $('#e-hidden').prop('checked', !!v.hidden);
            // LIFE-8: off unless saved; ticking it offers 15 minutes.
            $('#e-idle').prop('checked', !!v.idle_lock);
            $('#e-idle-min').val(v.idle_lock || 15);
            $('#e-keyfiles').empty();
            $('#e-use-keyfiles').prop('checked', (v.keyfiles || []).length > 0);
            ((v.keyfiles || []).length ? v.keyfiles : ['']).forEach(function (p) { addKeyfileRow(p); });
            var own = !v.mount_at || v.mount_at === '/mnt/addons/' + v.name;
            $('#e-mount-mode').val(own ? 'own' : 'share');
            $('#e-mount-at').val(own ? '' : v.mount_at);

            $('#e-share').val(v.share ? 'yes' : 'no');
            $('#e-export').val(v.share && v.share.export === 'hidden' ? 'hidden' : 'yes');
            var given = v.share ? v.share.users : {};
            var users = (options.users || []).slice();
            Object.keys(given).forEach(function (u) { if (users.indexOf(u) < 0) { users.push(u); } });
            $('#e-users').html(users.length
                ? users.map(function (u) { return userRow(u, Object.prototype.hasOwnProperty.call(given, u) ? given[u] : 'none'); }).join('')
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
            // A new volume starts folded; an existing one opens the sections
            // that hold settings, so they are seen at once.
            $('#f-mount').prop('open', !!(v.read_only || v.pim || v.hidden || v.idle_lock || (v.keyfiles || []).length));
            $('#f-share').prop('open', !!v.share);
            $('#f-deps').prop('open', (v.dependents || []).length > 0);
            $('#f-adv').prop('open', !!(v.display_name && v.display_name !== v.name) || !own);
            $('#vcm-list').hide();
            $('#vcm-edit').prop('hidden', false);
            $(editing ? '#e-name' : '#e-file').trigger('focus');
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
        if ($('#e-hidden').is(':checked')) { v.hidden = true; }
        if ($('#e-pim').is(':checked')) { v.pim = true; }
        if ($('#e-idle').is(':checked')) { v.idle_lock = wholeInt($('#e-idle-min').val()); }
        var keyfiles = editKeyfiles();
        if (keyfiles.length) { v.keyfiles = keyfiles; }
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
                grace: wholeInt($(this).find('.e-grace').val()),
                delay: wholeInt($(this).find('.e-delay').val())
            };
        }).get();
        if (deps.length) { v.dependents = deps; }
        return v;
    }

    /** First checks in the browser, mirroring check_config() in scripts/vcmount (Decision U1, audit B17.1). */
    function check(v) {
        if (!NAME.test(v.name)) { return 'The name may contain only letters, digits, - and _, at most 32 characters.'; }
        if (!plainMntPath(v.file)) { return 'Choose a valid volume file path under /mnt/ (no trailing /, ".." or control characters).'; }
        if (v.display_name !== undefined && (Array.from(v.display_name).length > 100 || /[\x00-\x1f\x7f]/.test(v.display_name))) {
            return 'The display name may be at most 100 characters, with no control characters.';
        }
        var taken = config.volumes.some(function (x) { return x.name === v.name && x.name !== editing; });
        if (taken) { return 'Another volume already has the name "' + v.name + '".'; }
        if (v.mount_at !== undefined && !validShareMountAt(v.mount_at)) {
            return 'Choose a folder inside a share: /mnt/user/<share>/<folder>, with no trailing /, "..", \\ or %.';
        }
        if ((v.keyfiles || []).length > MAX_KEYFILES) { return 'Too many keyfiles (at most ' + MAX_KEYFILES + ').'; }
        if ((v.keyfiles || []).some(function (k) { return !plainMntPath(k); })) { return 'A keyfile must be a plain file path under /mnt/.'; }
        if ((v.keyfiles || []).some(function (k) { return sameFile(k, v.file); })) { return 'The volume file cannot be its own keyfile.'; }
        if (v.idle_lock !== undefined && !(v.idle_lock >= 5 && v.idle_lock <= 1440)) {
            return 'Lock when idle: choose a whole number from 5 to 1440 minutes.';
        }
        if (v.share && RESERVED_SHARES.indexOf(v.name.toLowerCase()) >= 0) {
            return 'Samba reserves the name "' + v.name + '". Rename the volume to share it.';
        }
        if (v.share && !Object.keys(v.share.users).length) { return 'Give at least one user access to the share, or turn sharing off.'; }
        var bad = (v.dependents || []).some(function (d) {
            return !(d.grace >= 1 && d.grace <= 600 && d.delay >= 0 && d.delay <= 600);
        });
        if (bad) { return 'Each dependent needs a whole stop time of 1 to 600 seconds and a wait of 0 to 600.'; }
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
                // Apply stays greyed out unless there are changes (audit B16):
                // a refused "Remove" changed nothing in the form.
                $('#e-apply').prop('disabled', !dirty);
                editError(a.error || 'The settings could not be saved.');
                return;
            }
            config.revision = a.revision;
            config.volumes = volumes;
            markClean();
            checkPrivacy();
            // A mounted volume's share follows the new settings at once, as
            // the Edit panel says (audit 2026-11-27c, Part 3).
            act({ action: 'repair-shares' });
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
        }, function (yes) {
            if (!yes) { return; }
            save(config.volumes.filter(function (x) { return x.name !== name; }), closeEdit);
        });
    }

    // ---- Start ------------------------------------------------------------

    $(function () {
        // The password form first (review H1): it must never be left to the browser.
        $('#vcm-mount-form').on('submit', submitMount);
        $('#vcm-stop-other').on('click', stopOther);
        // A changed PIM is checked again.
        $('#vcm-pim').on('input', function () {
            if (!pimWarned) { return; }
            pimWarned = false;
            $('#vcm-pim-warn').prop('hidden', true);
            $('#vcm-mount-submit').val('Mount');
        });
        $('#vcm-http-warning').prop('hidden', !overHttp);

        // The list and the dialogs.
        $('#vcm-rows').on('click', '.vcm-mount', function () { stopQueue(); openDialog($(this).attr('data-name'), false, this); });
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
        $('#vcm-rows').on('click', '.vcm-info', function (e) { e.preventDefault(); showInfo($(this).attr('data-name'), this); });
        $('#vcm-add').on('click', function () { openEdit(''); });
        $('#vcm-mount-all').on('click', function () { mountAll(this); });
        $('#vcm-once').on('click', function () { stopQueue(); openDialog(null, false, this); });
        $('#vcm-dismount-all').on('click', dismountAll);
        $('#vcm-cancel').on('click', function () {
            if (checkingHttp) {   // nothing has been sent yet: just close
                checkingHttp = 0;
                $('#vcm-mount-submit').prop('disabled', false);
            } else if (mounting) { cancelUnlock(); return; }
            stopQueue(); closeDialog(); refresh();
        });
        $('#vcm-skip').on('click', function () {
            if (mounting || checkingHttp) { return; }   // audit 2026-11-27c B1
            closeDialog(true); nextInQueue();
        });
        // Escape closes and Tab cycles inside the open dialog (audit B16.10).
        $(document).on('keydown', function (e) {
            if (!$('#vcm-modal').prop('hidden')) {
                if (e.key === 'Escape') { $('#vcm-cancel').trigger('click'); return; }
                trapTab(e, $('#vcm-modal'));
            } else if ($('#vcm-info').length && !$('#vcm-info').prop('hidden')) {
                if ($('.sweet-alert.visible').length) { return; }
                if (e.key === 'Escape') { closeInfo(); return; }
                trapTab(e, $('#vcm-info'));
            }
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
            $('#e-deps').append(depItem({ container: container, grace: 10, delay: 0 }));
            depChoices();
            markDirty();
            updateSummaries();
        });
        // Keyfiles (KEY-2), in the edit panel and the dialog: another field, or one fewer.
        $('#e-keyfile-add, #vcm-keyfile-add').on('click', function (e) {
            e.preventDefault();
            var list = '#' + $(this).siblings('div').attr('id');
            // Use an empty field if there is one, rather than adding more.
            var empty = $(list).find('.e-keyfile').filter(function () { return $.trim($(this).val()) === ''; });
            (empty.length ? empty.first() : addKeyfileRow('', list).find('input')).trigger('focus');
        });
        $('#e-keyfiles, #vcm-keyfiles').on('input change', '.e-keyfile', function () {
            keyfileRows('#' + $(this).closest('#e-keyfiles, #vcm-keyfiles').attr('id'));
        });
        $('#e-keyfiles, #vcm-keyfiles').on('click', '.vcm-keyfile-remove', function (e) {
            e.preventDefault();
            var list = '#' + $(this).closest('#e-keyfiles, #vcm-keyfiles').attr('id');
            $(this).closest('.vcm-keyfile').remove();
            keyfileRows(list);
            if (list === '#e-keyfiles') { markDirty(); updateSummaries(); }
        });
        // Edit panel: the keyfile list appears when "Uses keyfiles" is ticked.
        $('#e-use-keyfiles').on('change', function () {
            if (this.checked) { setTimeout(function () { $('#e-keyfiles .e-keyfile').first().trigger('focus'); }, 0); }
        });
        // "Mount a file once": an extra appears when its box is ticked.
        $('#vcm-use-pim').on('change', function () {
            $('#vcm-pim').prop('hidden', !this.checked);
            if (this.checked) { $('#vcm-pim').trigger('focus'); } else { $('#vcm-pim').val(''); }
        });
        $('#vcm-use-keyfiles').on('change', function () {
            $('#vcm-keyfiles-box').prop('hidden', !this.checked);
            if (this.checked) { $('#vcm-keyfiles .e-keyfile').first().trigger('focus'); }
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

        // Put shares in order once, quietly (U4), then show the list. The list
        // is not refreshed while the edit panel is open.
        act({ action: 'repair-shares' }).always(refresh);
        setInterval(function () { if (editing === null) { refresh(); } }, REFRESH);
        // When the tab comes back: the list, and the File Activity check (PRIV-3).
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) { return; }
            checkPrivacy();
            if (editing === null) { refresh(); }
        });
    });
}(jQuery));

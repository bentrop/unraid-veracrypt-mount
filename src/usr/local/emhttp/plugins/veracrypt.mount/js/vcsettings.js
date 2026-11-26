/*
 * vcsettings.js: the behaviour of the Settings tab (docs/DESIGN-ui.md).
 *
 * The three settings are read with the action "config" and saved with
 * "save-config", together with the volume list exactly as it was read. The
 * revision makes the engine refuse the save if the file changed meanwhile.
 */
(function ($) {
    'use strict';

    var URL = '/plugins/veracrypt.mount/include/action.php';
    var overHttp = window.location.protocol === 'http:';
    var FIELDS = { force_at_array_stop: '#s-force', require_https: '#s-https', log_names: '#s-lognames', show_on_main: '#s-main' };

    var config = null;   // the saved settings as "vcmount config" returns them
    var dirty = false;

    /** Send one action. Always resolves, with the engine's answer or an error. */
    function act(data) {
        data.csrf_token = csrf_token;
        return $.ajax({ url: URL, method: 'POST', data: data, dataType: 'json', timeout: 60000 })
            .then(function (answer) { return answer; },
                  function () { return { ok: false, error: 'No answer from the server.' }; });
    }

    function error(text) {
        $('#vcs-error').text(text).prop('hidden', !text);
    }

    /** As on Unraid's own pages: Apply is greyed out until a change, Done turns into Reset. */
    function mark(changed) {
        dirty = changed;
        $('#vcs-apply').prop('disabled', !changed);
        $('#vcs-done').val(changed ? 'Reset' : 'Done');
    }

    function warn() {
        $('#s-https-warning').toggle(overHttp && $('#s-https').val() === 'yes');
    }

    /** Read the saved settings and show them. */
    function load() {
        $('#vcs-apply, #vcs-done').prop('disabled', true);
        act({ action: 'config' }).then(function (c) {
            $('#vcs-done').prop('disabled', false);
            if (!c.ok) {
                config = null;
                error(c.error || 'The settings could not be read.');
                return;
            }
            config = c;
            $.each(FIELDS, function (key, field) { $(field).val(c.settings[key] ? 'yes' : 'no'); });
            error('');
            mark(false);
            warn();
        });
    }

    function apply() {
        if (!config) { return; }
        var settings = {};
        $.each(FIELDS, function (key, field) { settings[key] = $(field).val() === 'yes'; });
        var data = { action: 'save-config', revision: config.revision,
                     config: JSON.stringify({ settings: settings, volumes: config.volumes }) };
        $('#vcs-apply, #vcs-done').prop('disabled', true);
        act(data).then(function (a) {
            $('#vcs-done').prop('disabled', false);
            if (!a.ok) {
                $('#vcs-apply').prop('disabled', false);
                error(a.error || 'The settings could not be saved.');
                return;
            }
            config.revision = a.revision;
            config.settings = settings;
            error('');
            mark(false);
        });
    }

    $(function () {
        $('#vcs-form').on('input change', function () { mark(true); warn(); });
        $('#vcs-apply').on('click', apply);
        // Reset brings back the saved settings. Done returns to the Volumes tab:
        // Unraid's done() would leave the plugin for the Settings overview. Like
        // done(), forget the remembered tab, then open this page again.
        $('#vcs-done').on('click', function () {
            if (dirty) { load(); return; }
            if ($.removeCookie) { $.removeCookie('one'); }
            location.replace(location.pathname);
        });
        load();
    });
}(jQuery));

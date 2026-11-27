<?php
/*
 * actions.php: the logic behind the web pages' requests
 * (docs/DESIGN-ui.md, sections 3 and 4).
 *
 * action.php is the thin web part that calls vcm_handle(). Tests call
 * vcm_handle() directly, without a browser.
 *
 * Every action starts the engine (vcmount) with --json, from a list of
 * arguments and without a shell (SEC-3), and passes its answer back. There is
 * no mount logic here (CLI-1).
 *
 * A password is written into the engine's standard input and nowhere else:
 * never a command line, an environment variable, a file, a log or an error
 * message (SEC-1).
 */

const VCM_ENGINE = '/usr/local/emhttp/plugins/veracrypt.mount/scripts/vcmount';

// The same patterns and limits as the engine (audit B17.1).
const VCM_NAME = '/\A[A-Za-z0-9][A-Za-z0-9_-]{0,31}\z/';
const VCM_PIM = '/\A[1-9][0-9]{0,8}\z/';
const VCM_UNLOCK_ID = '/\A[0-9a-f]{16,64}\z/';
const VCM_MAX_KEYFILES = 8;

// Seconds the engine may take. It stops cryptsetup itself after 180.
const VCM_TIMEOUT = 300;
// Seconds between asking a timed-out engine to stop and ending it (as the
// engine's own KILL_GRACE for the programs it starts).
const VCM_KILL_GRACE = 5;

// The longest password accepted, in bytes: VeraCrypt's own limit
// (review H7, audit B13), so a longer one gets a clear message instead of "wrong password".
const VCM_MAX_PASSWORD = 128;

/**
 * Plain path below /mnt/, mirroring plain_mnt_path() in scripts/vcmount
 * (audit B17.1): no trailing slash, no "//", no "." or "..", no control bytes.
 */
function vcm_plain_mnt_path(string $path): bool
{
    return str_starts_with($path, '/mnt/') && strlen($path) <= 4096
        && !str_ends_with($path, '/') && strpos($path, '//') === false
        && !preg_match('#/\.\.?(/|\z)#', $path) && !preg_match('/[\x00-\x1f\x7f]/', $path);
}

/**
 * Mirror of same_file() in scripts/vcmount: /mnt/user/<share>/x and
 * /mnt/<disk>/<share>/x count as the same file.
 */
function vcm_same_file(string $one, string $two): bool
{
    if ($one === $two) {
        return true;
    }
    $pattern = '#\A/mnt/([^/]+)/(.+)\z#';
    if (!preg_match($pattern, $one, $a) || !preg_match($pattern, $two, $b)) {
        return false;
    }
    $through_user_share = in_array($a[1], ['user', 'user0'], true) || in_array($b[1], ['user', 'user0'], true);
    return $through_user_share && $a[2] === $b[2];
}

/**
 * Handle one request.
 *
 * $post:   the request's fields (action, name, password, file, read_only, config)
 * $https:  whether the request came over HTTPS
 * $engine: the engine to start; tests pass the development copy
 *
 * Returns the answer for the page: the engine's JSON answer as an array, or
 * ['ok' => false, 'code' => ..., 'error' => ...].
 */
// #[\SensitiveParameter] (review H2): should PHP ever write a stack trace of
// these functions, it shows a placeholder instead of the start of the password.
function vcm_handle(#[\SensitiveParameter] array &$post, bool $https, string $engine = VCM_ENGINE): array
{
    $action = is_string($post['action'] ?? null) ? $post['action'] : '';
    $name = is_string($post['name'] ?? null) ? $post['name'] : '';
    $stdin = null;

    $needs_name = ['status', 'info', 'fix-top', 'fix-permissions', 'mount', 'mount-once', 'dismount', 'dismount-force'];
    if (in_array($action, $needs_name, true) && !preg_match(VCM_NAME, $name)) {
        return vcm_refuse('That is not a valid volume name.');
    }

    switch ($action) {
        case 'list':
            $args = ['list'];
            break;
        case 'busy':
            $args = ['busy'];
            break;
        case 'cancel-unlock':
            $args = ['cancel-unlock'];
            $unlock_id = $post['unlock_id'] ?? '';
            if (!is_string($unlock_id) || ($unlock_id !== '' && !preg_match(VCM_UNLOCK_ID, $unlock_id))) {
                return vcm_refuse('That is not a valid unlock identifier.');
            }
            if ($unlock_id !== '') {
                $args[] = '--unlock-id';
                $args[] = $unlock_id;
            }
            break;
        case 'status':
            $args = ['status', $name];
            break;
        case 'mount':
        case 'mount-once':
            $unlock_id = $post['unlock_id'] ?? '';
            if (!is_string($unlock_id) || ($unlock_id !== '' && !preg_match(VCM_UNLOCK_ID, $unlock_id))) {
                return vcm_refuse('That is not a valid unlock identifier.');
            }
            // Taken out of the request, so this is the only copy (audit
            // 2026-11-27c S6): $post is the caller's array, by reference.
            $password = $post['password'] ?? null;
            $pim = $post['pim'] ?? '';
            unset($post['password'], $post['pim']);
            // VeraCrypt allows a volume with keyfiles and no password. The page
            // says so with no_password=1, only when keyfiles are used.
            $no_password = ($post['no_password'] ?? '') === '1';
            if (!is_string($password) || ($password === '' && !$no_password)) {
                return vcm_refuse('Enter the password.');
            }
            // A line break would end the password early in cryptsetup.
            if (strpbrk($password, "\0\r\n") !== false) {
                return vcm_refuse('The password contains a line break.');
            }
            // VeraCrypt counts bytes: a letter such as ü takes two (audit B13).
            if (strlen($password) > VCM_MAX_PASSWORD) {
                return vcm_refuse('The password is longer than VeraCrypt allows (' . VCM_MAX_PASSWORD
                    . ' bytes; letters such as ü count twice, emoji four times).');
            }
            // The PIM, if the volume has one: digits only, sent after the
            // password on the engine's standard input (SEC-1), never as an argument.
            if (!is_string($pim) || ($pim !== '' && !preg_match(VCM_PIM, $pim))) {
                return vcm_refuse('The PIM must be a whole number from 1 upwards, without spaces.');
            }
            if ($action === 'mount') {
                // Mirror the engine's saved-volume rules before starting it,
                // so a missing or unexpected PIM or an empty password without
                // keyfiles is refused before the password leaves PHP (review K4,
                // audit S11, B17.1). The engine checks the same flags again.
                $status = vcm_run($engine, ['status', $name, '--json']);
                $saved = is_array($status['volume'] ?? null) ? $status['volume'] : null;
                if ($saved !== null && !empty($saved['pim']) && $pim === '') {
                    return vcm_refuse('This volume asks for a PIM. Enter it.');
                }
                if ($saved !== null && empty($saved['pim']) && $pim !== '') {
                    return vcm_refuse('This volume does not use a PIM.');
                }
                if ($saved !== null && $password === '' && ($saved['keyfiles'] ?? []) === []) {
                    return vcm_refuse('Enter the password.');
                }
                $args = ['mount', $name, $pim !== '' ? '--pim' : '--no-pim'];
                if ($password === '') {
                    $args[] = '--no-password';
                }
            } else {
                // Mount without saving (VOL-5).
                $file = $post['file'] ?? null;
                if (!is_string($file) || !vcm_plain_mnt_path($file)) {
                    return vcm_refuse('That is not a valid path to a volume file.');
                }
                $args = ['mount', '--file', $file, '--name', $name];
                if (($post['read_only'] ?? '') === '1') {
                    $args[] = '--read-only';
                }
                if (($post['hidden'] ?? '') === '1') {
                    $args[] = '--hidden';
                }
                if ($pim !== '') {
                    $args[] = '--pim';
                }
                $keyfiles = $post['keyfiles'] ?? [];
                if (!is_array($keyfiles) || count($keyfiles) > VCM_MAX_KEYFILES) {
                    return vcm_refuse('Too many keyfiles.');
                }
                foreach ($keyfiles as $keyfile) {
                    if (!is_string($keyfile) || !vcm_plain_mnt_path($keyfile)) {
                        return vcm_refuse('A keyfile must be a plain file path under /mnt/.');
                    }
                    if (vcm_same_file($keyfile, $file)) {
                        return vcm_refuse('The volume file cannot be its own keyfile.');
                    }
                    $args[] = '--keyfile';
                    $args[] = $keyfile;
                }
                if ($password === '' && $keyfiles === []) {
                    return vcm_refuse('Enter the password.');
                }
                if ($password === '') {
                    $args[] = '--no-password';
                }
            }
            if ($unlock_id !== '') {
                $args[] = '--unlock-id';
                $args[] = $unlock_id;
            }
            // The engine refuses this when the setting "require HTTPS" is on (UI-5).
            if (!$https) {
                $args[] = '--over-http';
            }
            // With a PIM, cryptsetup reads the password as the first line and
            // the PIM as the second. A saved volume that asks for a PIM gets
            // one only when the page sent it; the engine then says it is wrong.
            // The password always ends with a line break: with keyfiles and no
            // password, cryptsetup needs an empty line, and refuses no input
            // at all ("Nothing to read on input", tested on the test server, audit B5).
            $stdin = $password . "\n" . ($pim === '' ? '' : $pim . "\n");
            unset($password, $pim);
            break;
        case 'dismount':
            $args = ['dismount', $name];
            break;
        case 'dismount-force':
            $args = ['dismount', $name, '--force'];
            break;
        case 'dismount-all':
            $args = ['dismount', '--all'];
            break;
        case 'repair-shares':
            $args = ['repair-shares'];
            break;
        case 'options':
            $args = ['options'];
            break;
        case 'privacy':
            $args = ['privacy'];
            break;
        case 'info':
            $args = ['info', $name];
            break;
        case 'fix-top':
        case 'fix-permissions':
            $args = [$action, $name];
            break;
        case 'config':
            $args = ['config'];
            break;
        case 'save-config':
            $config = $post['config'] ?? null;
            if (!is_string($config) || $config === '') {
                return vcm_refuse('No settings were sent.');
            }
            $args = ['save-config'];
            // The revision read with "config". The engine refuses to save when
            // the file has changed since, so no change is overwritten unseen.
            // Always required from the page (audit S11).
            $revision = $post['revision'] ?? null;
            if (!is_string($revision) || !preg_match('/\A([0-9a-f]{64}|none)\z/', $revision)) {
                return vcm_refuse('The settings could not be saved: the page did not say which version it read. Reload the page.');
            }
            $args[] = '--revision';
            $args[] = $revision;
            $stdin = $config;
            break;
        default:
            return vcm_refuse('Unknown action.');
    }

    $args[] = '--json';
    $answer = vcm_run($engine, $args, $stdin);
    $stdin = null;   // vcm_run() has already cleared it through the reference
    return $answer;
}

/**
 * End an engine that ran out of time: ask first, then force it after
 * VCM_KILL_GRACE seconds (audit B6). proc_close() alone would wait for as long
 * as the engine ignores the request.
 */
function vcm_stop($process): void
{
    proc_terminate($process, 15);
    $until = microtime(true) + VCM_KILL_GRACE;
    while (proc_get_status($process)['running'] && microtime(true) < $until) {
        usleep(100000);
    }
    if (proc_get_status($process)['running']) {
        proc_terminate($process, 9);
    }
    proc_close($process);
}

/** An answer that refuses a request before the engine is started. */
function vcm_refuse(string $message): array
{
    return ['ok' => false, 'code' => 1, 'error' => $message];
}

/**
 * Start the engine and return its JSON answer. $stdin is written into its
 * standard input and then closed; null gives it an empty standard input.
 *
 * Writing and reading share one loop and one time limit (audit B6): a pipe
 * takes only so much at once, so the input goes in pieces as the engine
 * reads it, every write is checked, and an engine that stops reading or
 * answering cannot hold this web request. If the engine ends early (for
 * example a refused save), the rest of the input is dropped quietly.
 */
function vcm_run(string $engine, array $args, #[\SensitiveParameter] ?string &$stdin = null): array
{
    $command = array_merge(['/usr/bin/php', $engine], $args);
    $spec = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        // Error messages of the programs the engine starts are not passed on:
        // the engine's JSON answer already says what went wrong.
        2 => ['file', '/dev/null', 'w'],
    ];
    $process = proc_open($command, $spec, $pipes);
    if (!is_resource($process)) {
        return ['ok' => false, 'code' => 1, 'error' => 'The engine could not be started.'];
    }
    stream_set_blocking($pipes[0], false);
    stream_set_blocking($pipes[1], false);
    $input = $pipes[0];
    $sent = 0;
    $length = $stdin === null ? 0 : strlen($stdin);
    if ($length === 0) {
        fclose($input);
        $input = null;
    }

    $out = '';
    $deadline = microtime(true) + VCM_TIMEOUT;
    while (!feof($pipes[1])) {
        $left = $deadline - microtime(true);
        if ($left <= 0) {
            if ($input !== null) {
                fclose($input);
            }
            $stdin = null;   // through the reference, the caller's copy too (audit 2026-11-27c S6)
            fclose($pipes[1]);
            vcm_stop($process);
            // It may have done part of the work (mounted, but not all
            // dependents started; one of several volumes dismounted). The
            // page then looks at the real state (review of B6, finding 2).
            return ['ok' => false, 'code' => 1, 'timed_out' => true,
                    'error' => 'The engine took too long and was stopped. What it finished stays done; '
                             . 'the list shows the current state.'];
        }
        $read = [$pipes[1]];
        $write = $input === null ? null : [$input];
        $except = null;
        if (@stream_select($read, $write, $except, (int) ceil($left)) === false) {
            usleep(50000);   // interrupted by a signal: look again, without spinning (review finding 3)
            continue;
        }
        if ($write) {
            // As much as the pipe takes now. false: the engine closed its input
            // (it ended early), so the rest is not needed. PHP ignores the
            // "broken pipe" signal; the @ keeps its warning out of the log.
            $wrote = @fwrite($input, $sent === 0 ? $stdin : substr($stdin, $sent));
            $sent += $wrote === false ? 0 : $wrote;
            if ($wrote === false || $sent >= $length) {
                fclose($input);
                $input = null;
                // Drop the secret from PHP memory as soon as the pipe has it (audit 2026-11-27b S3).
                $stdin = null;
            }
        }
        if ($read) {
            $out .= (string) fread($pipes[1], 65536);
        }
    }
    if ($input !== null) {
        fclose($input);
    }
    $stdin = null;   // through the reference, the caller's copy too (audit 2026-11-27c S6)
    fclose($pipes[1]);
    $code = proc_close($process);

    $answer = json_decode($out, true);
    if (!is_array($answer)) {
        return ['ok' => false, 'code' => $code, 'error' => 'The engine gave no valid answer.'];
    }
    $answer['code'] = $answer['code'] ?? $code;
    return $answer;
}

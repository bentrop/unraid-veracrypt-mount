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

// The same pattern as the engine's volume names.
const VCM_NAME = '/\A[A-Za-z0-9][A-Za-z0-9_-]{0,31}\z/';

// Seconds the engine may take. It stops cryptsetup itself after 180.
const VCM_TIMEOUT = 300;

// The longest password accepted, in characters: VeraCrypt's own limit
// (review H7), so a longer one gets a clear message instead of "wrong password".
const VCM_MAX_PASSWORD = 128;

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
function vcm_handle(#[\SensitiveParameter] array $post, bool $https, string $engine = VCM_ENGINE): array
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
        case 'status':
            $args = ['status', $name];
            break;
        case 'mount':
        case 'mount-once':
            $password = $post['password'] ?? null;
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
            if (mb_strlen($password, 'UTF-8') > VCM_MAX_PASSWORD) {
                return vcm_refuse('The password is longer than VeraCrypt allows (' . VCM_MAX_PASSWORD . ' characters).');
            }
            // The PIM, if the volume has one: digits only, sent after the
            // password on the engine's standard input (SEC-1), never as an argument.
            $pim = $post['pim'] ?? '';
            if (!is_string($pim) || ($pim !== '' && !preg_match('/\A[1-9][0-9]{0,8}\z/', $pim))) {
                return vcm_refuse('The PIM must be a whole number from 1 upwards, without spaces.');
            }
            if ($action === 'mount') {
                $args = ['mount', $name];
            } else {
                // Mount without saving (VOL-5).
                $file = $post['file'] ?? null;
                if (!is_string($file) || $file === '' || $file[0] !== '/' || strlen($file) > 4096
                    || preg_match('/[\x00-\x1f]/', $file)) {
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
                if (!is_array($keyfiles) || count($keyfiles) > 8) {
                    return vcm_refuse('Too many keyfiles.');
                }
                foreach ($keyfiles as $keyfile) {
                    if (!is_string($keyfile) || !str_starts_with($keyfile, '/mnt/') || strlen($keyfile) > 4096
                        || preg_match('/[\x00-\x1f]/', $keyfile)) {
                        return vcm_refuse('A keyfile must be a file under /mnt/.');
                    }
                    $args[] = '--keyfile';
                    $args[] = $keyfile;
                }
                if ($password === '' && $keyfiles === []) {
                    return vcm_refuse('Enter the password.');
                }
            }
            // The engine refuses this when the setting "require HTTPS" is on (UI-5).
            if (!$https) {
                $args[] = '--over-http';
            }
            // With a PIM, cryptsetup reads the password as the first line and
            // the PIM as the second. A saved volume that asks for a PIM gets
            // one only when the page sent it; the engine then says it is wrong.
            $stdin = $pim === '' ? $password : $password . "\n" . $pim . "\n";
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
            $revision = $post['revision'] ?? null;
            if ($revision !== null) {
                if (!is_string($revision) || !preg_match('/\A([0-9a-f]{64}|none)\z/', $revision)) {
                    return vcm_refuse('That is not a valid revision.');
                }
                $args[] = '--revision';
                $args[] = $revision;
            }
            $stdin = $config;
            break;
        default:
            return vcm_refuse('Unknown action.');
    }

    $args[] = '--json';
    $answer = vcm_run($engine, $args, $stdin);
    unset($stdin);
    return $answer;
}

/** An answer that refuses a request before the engine is started. */
function vcm_refuse(string $message): array
{
    return ['ok' => false, 'code' => 1, 'error' => $message];
}

/**
 * Start the engine and return its JSON answer. $stdin is written into its
 * standard input and then closed; null gives it an empty standard input.
 */
function vcm_run(string $engine, array $args, #[\SensitiveParameter] ?string $stdin): array
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
    if ($stdin !== null) {
        fwrite($pipes[0], $stdin);
    }
    fclose($pipes[0]);
    unset($stdin);

    // Wait for the answer, with a time limit.
    stream_set_blocking($pipes[1], false);
    $out = '';
    $deadline = microtime(true) + VCM_TIMEOUT;
    while (!feof($pipes[1])) {
        $left = $deadline - microtime(true);
        if ($left <= 0) {
            proc_terminate($process);
            fclose($pipes[1]);
            proc_close($process);
            return ['ok' => false, 'code' => 1, 'error' => 'The engine took too long and was stopped.'];
        }
        $read = [$pipes[1]];
        $write = null;
        $except = null;
        if (stream_select($read, $write, $except, (int) ceil($left)) > 0) {
            $out .= (string) fread($pipes[1], 65536);
        }
    }
    fclose($pipes[1]);
    $code = proc_close($process);

    $answer = json_decode($out, true);
    if (!is_array($answer)) {
        return ['ok' => false, 'code' => $code, 'error' => 'The engine gave no valid answer.'];
    }
    $answer['code'] = $answer['code'] ?? $code;
    return $answer;
}

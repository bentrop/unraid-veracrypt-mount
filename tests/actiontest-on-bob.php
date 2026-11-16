<?php
/*
 * actiontest-on-bob.php: tests of actions.php (the logic behind the web
 * pages) and of the engine commands options and save-config.
 *
 * Copied to /tmp/vcmount-dev by scripts/deploy.sh and started by
 * scripts/actiontest.sh. Do not start it by hand.
 *
 * Usage:  php /tmp/vcmount-dev/actiontest-on-bob.php config|mount
 *
 *   config  no password. options, list, save-config (valid and invalid),
 *           requests actions.php must refuse.
 *   mount   the throwaway password arrives on standard input and is handed to
 *           vcm_handle() exactly as the web page will hand it over. It is
 *           never printed. Only the throwaway NTFS volume is used.
 *
 * The settings file used is /tmp/vcmount-dev/volumes.action-test.json, never
 * the one on the flash drive. It is removed at the end.
 */

const DIR = '/tmp/vcmount-dev';
const ENGINE = DIR . '/vcmount';
const CONFIG = DIR . '/volumes.action-test.json';
const NAME = 'throwaway-ntfs';
const FILE = '/mnt/user/data/veracrypt/throwaway-ntfs';

require DIR . '/actions.php';
putenv('VCMOUNT_CONFIG=' . CONFIG);

$fails = 0;

function step(string $text): void
{
    echo "\n--- $text\n";
}

function check(bool $ok, string $what): void
{
    global $fails;
    echo $ok ? "ok:   $what\n" : "FAIL: $what\n";
    if (!$ok) {
        $fails++;
    }
}

/** A request as the web page sends it. Over plain HTTP unless $https. */
function ask(array $post, bool $https = false): array
{
    $answer = vcm_handle($post, $https, ENGINE);
    $show = $answer;
    unset($show['volumes'], $show['volume']);
    echo '      answer: ', json_encode($show, JSON_UNESCAPED_SLASHES), "\n";
    return $answer;
}

function settings_json(bool $require_https): string
{
    return json_encode([
        'settings' => ['require_https' => $require_https],
        'volumes' => [['name' => NAME, 'display_name' => NAME, 'file' => FILE]],
    ]);
}

function is_locked(): bool
{
    return !file_exists('/dev/mapper/vcm-' . NAME);
}

function finish(): void
{
    global $fails, $case;
    step('Clean up');
    if (!is_locked()) {
        echo '"' . NAME . "\" is not locked; trying one normal dismount\n";
        vcm_handle(['action' => 'dismount', 'name' => NAME], false, ENGINE);
        check(is_locked(), 'now locked');
    }
    @unlink(CONFIG);
    echo "\n", $fails === 0 ? "PASS: $case\n" : "FAIL: $case ($fails check(s) failed)\n";
    exit($fails === 0 ? 0 : 1);
}

$case = $argv[1] ?? '';
if (!in_array($case, ['config', 'mount'], true)) {
    echo "Usage: php actiontest-on-bob.php config|mount\n";
    exit(1);
}

step('Before: the throwaway volume must be locked');
if (!is_locked() || file_exists(CONFIG)) {
    echo 'Stopped: "' . NAME . '" is not locked or ' . CONFIG . " exists. Nothing was done.\n";
    exit(1);
}
check(true, 'it is locked');
file_put_contents(CONFIG, settings_json(false));

if ($case === 'config') {
    step('Requests that must be refused before the engine is started');
    check(ask(['action' => 'format-disk'])['ok'] === false, 'unknown action');
    check(ask(['action' => 'status', 'name' => 'a b'])['ok'] === false, 'bad volume name');
    check(ask(['action' => 'status', 'name' => '--all'])['ok'] === false, 'name that looks like an option');
    check(ask(['action' => 'save-config', 'config' => ''])['ok'] === false, 'empty settings');

    step('options');
    $a = ask(['action' => 'options']);
    check(($a['ok'] ?? false) === true, 'answered');
    check(is_array($a['users'] ?? null) && $a['users'] !== [], 'lists Unraid users');
    check(is_array($a['containers'] ?? null), 'lists containers');

    step('list includes the settings');
    $a = ask(['action' => 'list']);
    check(($a['settings']['require_https'] ?? null) === false, 'require_https is shown');
    check(($a['settings']['force_at_array_stop'] ?? null) === true, 'force_at_array_stop has its default');

    step('save-config with valid settings');
    $valid = json_encode([
        'settings' => ['require_https' => true, 'show_on_main' => false],
        'volumes' => [[
            'name' => NAME, 'display_name' => NAME, 'file' => FILE, 'unknown_field' => 1,
            'share' => ['export' => 'hidden', 'users' => ['@TEST_USER@' => 'read-write']],
            'dependents' => [['container' => 'vcm-test-good', 'grace' => 5]],
        ]],
    ]);
    $a = ask(['action' => 'save-config', 'config' => $valid]);
    check(($a['ok'] ?? false) === true, 'saved');
    $saved = json_decode((string) file_get_contents(CONFIG), true);
    check(($saved['settings']['require_https'] ?? null) === true, 'the setting was written');
    check(($saved['volumes'][0]['share']['users'] ?? null) === ['@TEST_USER@' => 'read-write'], 'the share was written');
    check(($saved['volumes'][0]['share']['export'] ?? null) === 'hidden', 'the share is hidden');
    check(!isset($saved['volumes'][0]['display_name']), 'a display name equal to the name was left out');
    check(!isset($saved['volumes'][0]['unknown_field']), 'an unknown field was dropped');
    check(($saved['volumes'][0]['dependents'][0]['delay'] ?? null) === 0, 'the dependent got its default delay');
    check(!file_exists(CONFIG . '.new'), 'no temporary file left');

    step('save-config with invalid settings: each refused, the file unchanged');
    $before = (string) file_get_contents(CONFIG);
    $bad = [
        'not JSON' => '{"volumes": [',
        'bad volume name' => json_encode(['volumes' => [['name' => 'a b', 'file' => FILE]]]),
        'the same name twice' => json_encode(['volumes' => [['name' => 'x', 'file' => FILE], ['name' => 'x', 'file' => FILE]]]),
        'relative file path' => json_encode(['volumes' => [['name' => 'x', 'file' => 'data/x']]]),
        'bad share user' => json_encode(['volumes' => [['name' => 'x', 'file' => FILE, 'share' => ['users' => ['Bad User' => 'read-write']]]]]),
        'unknown access level' => json_encode(['volumes' => [['name' => 'x', 'file' => FILE, 'share' => ['users' => ['@TEST_USER@' => 'full']]]]]),
        'users as a plain list' => json_encode(['volumes' => [['name' => 'x', 'file' => FILE, 'share' => ['users' => ['@TEST_USER@']]]]]),
        'unknown export' => json_encode(['volumes' => [['name' => 'x', 'file' => FILE, 'share' => ['export' => 'public', 'users' => ['@TEST_USER@' => 'read-only']]]]]),
        'share without users' => json_encode(['volumes' => [['name' => 'x', 'file' => FILE, 'share' => ['users' => []]]]]),
        'grace period 0' => json_encode(['volumes' => [['name' => 'x', 'file' => FILE, 'dependents' => [['container' => 'c', 'grace' => 0]]]]]),
        'setting that is not yes or no' => json_encode(['settings' => ['require_https' => 'yes'], 'volumes' => []]),
        'settings that are not a list' => json_encode(['settings' => 'yes', 'volumes' => []]),
    ];
    foreach ($bad as $what => $config) {
        $a = ask(['action' => 'save-config', 'config' => $config]);
        check(($a['ok'] ?? true) === false && ($a['code'] ?? 0) === 1, "refused: $what");
    }
    check((string) file_get_contents(CONFIG) === $before, 'the file is unchanged');

    step('config returns the settings and their revision');
    $a = ask(['action' => 'config']);
    $revision = (string) ($a['revision'] ?? '');
    check(($a['ok'] ?? false) === true && preg_match('/^[0-9a-f]{64}$/', $revision) === 1, 'answered with a revision');
    check($revision === hash('sha256', $before), 'the revision is the fingerprint of the file');
    check(($a['volumes'][0]['name'] ?? '') === NAME, 'the volume is listed');

    step('save-config with an old revision is refused, the file unchanged');
    $a = ask(['action' => 'save-config', 'config' => settings_json(false), 'revision' => str_repeat('0', 64)]);
    check(($a['code'] ?? 0) === 3, 'refused with code 3');
    check((string) file_get_contents(CONFIG) === $before, 'the file is unchanged');
    $a = ask(['action' => 'save-config', 'config' => settings_json(false), 'revision' => 'not-a-revision']);
    check(($a['ok'] ?? true) === false, 'a malformed revision is refused');

    step('save-config with the current revision');
    $a = ask(['action' => 'save-config', 'config' => settings_json(false), 'revision' => $revision]);
    check(($a['ok'] ?? false) === true, 'saved');
    check(($a['revision'] ?? '') === hash('sha256', (string) file_get_contents(CONFIG)), 'the answer has the new revision');
    check(($a['revision'] ?? '') !== $revision, 'the revision changed');
    finish();
}

// case mount
$password = rtrim((string) stream_get_contents(STDIN), "\r\n");
if ($password === '') {
    echo "Stopped: no password arrived on standard input. Nothing was done.\n";
    exit(1);
}

step('Mount over plain HTTP while "require HTTPS" is on');
file_put_contents(CONFIG, settings_json(true));
$a = ask(['action' => 'mount', 'name' => NAME, 'password' => $password], false);
check(($a['code'] ?? 0) === 3, 'refused with code 3');
check(strpos((string) ($a['error'] ?? ''), 'require HTTPS') !== false, 'the message names the setting');
check(is_locked(), 'the volume stays locked');

step('A password with a line break is refused before the engine starts');
$a = ask(['action' => 'mount', 'name' => NAME, 'password' => "abc\ndef"]);
check(($a['ok'] ?? true) === false && is_locked(), 'refused, still locked');

step('Turn "require HTTPS" off through save-config');
$a = ask(['action' => 'save-config', 'config' => settings_json(false)]);
check(($a['ok'] ?? false) === true, 'saved');

step('Mount over plain HTTP, password handed over as the web page does');
$a = ask(['action' => 'mount', 'name' => NAME, 'password' => $password], false);
unset($password);
check(($a['ok'] ?? false) === true && ($a['code'] ?? 1) === 0, 'mounted (code 0)');
check(($a['volume']['state'] ?? '') === 'mounted', 'the answer says mounted');

step('status');
$a = ask(['action' => 'status', 'name' => NAME]);
check(($a['volume']['mounted_at'] ?? '') === '/mnt/addons/' . NAME, 'mounted at /mnt/addons/' . NAME);

step('Removing or renaming the mounted volume is refused (D3)');
$before = (string) file_get_contents(CONFIG);
$a = ask(['action' => 'save-config', 'config' => json_encode(['volumes' => []])]);
check(($a['code'] ?? 0) === 3, 'removing it is refused with code 3');
$a = ask(['action' => 'save-config', 'config' => json_encode(['volumes' => [['name' => 'renamed', 'file' => FILE]]])]);
check(($a['code'] ?? 0) === 3, 'renaming it is refused with code 3');
check((string) file_get_contents(CONFIG) === $before, 'the file is unchanged');
$a = ask(['action' => 'save-config', 'config' => json_encode(['volumes' => [['name' => NAME, 'file' => FILE, 'display_name' => 'Changed while mounted']]])]);
check(($a['ok'] ?? false) === true, 'changing its display name is allowed');

step('Dismount');
$a = ask(['action' => 'dismount', 'name' => NAME]);
check(($a['ok'] ?? false) === true, 'dismounted');
check(is_locked(), 'the volume is locked');
finish();

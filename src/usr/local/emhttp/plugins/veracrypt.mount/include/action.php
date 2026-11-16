<?php
/*
 * action.php: the one address the plugin's web pages send requests to
 * (docs/DESIGN-ui.md, section 3). The logic is in actions.php.
 *
 * Unraid runs its own local_prepend.php before this file (auto_prepend_file in
 * /etc/php.ini). It stops every POST request without the right CSRF token
 * before this code runs (SEC-2).
 */

require_once __DIR__ . '/actions.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'code' => 1, 'error' => 'Only POST requests are accepted.']);
    exit;
}

// Unlocking can take long; the engine has its own time limits.
set_time_limit(VCM_TIMEOUT + 30);

$https = ($_SERVER['HTTPS'] ?? '') !== '' && strtolower($_SERVER['HTTPS']) !== 'off';

// dev-only-begin (scripts/build.py leaves this out of the package)
// Development only: if a file volumes.dev.json lies next to the engine, the
// engine reads it instead of the settings on the flash drive, as the event
// hooks do. The package never contains that file; scripts/deployweb.sh puts it
// there for tests.
$dev_config = dirname(VCM_ENGINE) . '/volumes.dev.json';
if (is_file($dev_config)) {
    putenv("VCMOUNT_CONFIG=$dev_config");
}
// dev-only-end

// Take the fields out of PHP's request arrays, so the password is held in one
// place only, and drop it as soon as the engine has it.
$post = $_POST;
$_POST = [];
$_REQUEST = [];

// Review H2: an unexpected error must not reach PHP's error output with the
// request in it. The answer is a fixed text; the details are not passed on.
try {
    $answer = vcm_handle($post, $https);
} catch (\Throwable $e) {
    $answer = ['ok' => false, 'code' => 1, 'error' => 'The request failed unexpectedly. Nothing was mounted.'];
}
unset($post, $e);
echo json_encode($answer, JSON_UNESCAPED_SLASHES);

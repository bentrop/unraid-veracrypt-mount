<?php
/*
 * The mount dialog, shared by the Volumes tab and the Dashboard tile, so there
 * is one password form to maintain and review. Markup only: js/vcmount.js
 * gives it its behaviour.
 */

// Unraid's display settings for usage bars (Settings > Display Settings), for the
// script to colour bars exactly as Unraid's usage_color() does (Helpers.php).
$vcm_display = $GLOBALS['display'] ?? [];
?>
<div id="vcm-display" hidden
     data-text="<?= (int) ($vcm_display['text'] ?? 0) ?>"
     data-warning="<?= (int) ($vcm_display['warning'] ?? 0) ?>"
     data-critical="<?= (int) ($vcm_display['critical'] ?? 0) ?>"></div>
<!-- The mount dialog. A real form with a real password field, so a password
     manager can fill it (UI-4). The hidden user name field holds the volume
     name, so the manager keeps one entry per volume. -->
<div id="vcm-modal" class="vcm-modal" role="dialog" aria-modal="true" aria-labelledby="vcm-mount-title" hidden>
  <!-- method, action and onsubmit are a fallback only (review H1): should the
       page script ever fail, a plain form would be sent as GET and put the
       password into the address. With these, it is never sent at all. -->
  <form id="vcm-mount-form" class="vcm-box" autocomplete="on" method="post" action="about:blank" onsubmit="return false">
    <h3 id="vcm-mount-title">Mount</h3>
    <input type="text" id="vcm-user" name="username" autocomplete="username" class="vcm-offscreen" tabindex="-1" readonly>
    <!-- Labels beside the fields; rows are display:contents, so hiding a row
         hides its label and field together. -->
    <div class="vcm-grid">
      <div id="vcm-once-fields" class="vcm-row" hidden>
        <!-- VOL-5 leaves no trace, so the browser must not remember these either.
             The file picker puts its folder tree right after the field, so the
             field is not inside its label. -->
        <label for="vcm-file">Volume file</label>
        <div><input type="text" id="vcm-file" placeholder="/mnt/user/..." spellcheck="false" autocomplete="off"
                    data-pickroot="/mnt/" data-pickcloseonfile="true"></div>
        <label for="vcm-name">Name</label>
        <div><input type="text" id="vcm-name" maxlength="32" placeholder="letters, digits, - and _" spellcheck="false" autocomplete="off"></div>
      </div>
      <div id="vcm-password-label" class="vcm-row">
        <label for="vcm-password">Password</label>
        <div><input type="password" id="vcm-password" name="password" autocomplete="current-password"></div>
      </div>
      <!-- What else unlocking needs. For "Mount a file once" each extra is
           switched on by its box; a saved volume shows only its PIM field. -->
      <div id="vcm-opts" class="vcm-opts">
        <!-- The PIM is sent with the password and goes the same way (SEC-1). -->
        <div class="vcm-opt">
          <label class="vcm-check vcm-once-only"><input type="checkbox" id="vcm-use-pim"> Use PIM</label>
          <label for="vcm-pim" class="vcm-saved-only">PIM</label>
          <input type="password" id="vcm-pim" inputmode="numeric" maxlength="9" autocomplete="off">
        </div>
        <label class="vcm-check vcm-once-only"><input type="checkbox" id="vcm-use-keyfiles"> Use keyfiles</label>
        <div id="vcm-keyfiles-box" class="vcm-sub vcm-once-only">
          <div id="vcm-keyfiles"></div>
          <a href="#" id="vcm-keyfile-add"><i class="fa fa-fw fa-plus"></i> Add another keyfile</a>
        </div>
        <label class="vcm-check vcm-once-only"><input type="checkbox" id="vcm-read-only"> Read-only</label>
        <label class="vcm-check vcm-once-only"><input type="checkbox" id="vcm-hidden"> Open the hidden volume inside</label>
      </div>
    </div>
    <p id="vcm-keyfile-note" class="vcm-note" hidden></p>
    <p id="vcm-once-note" class="vcm-note">Nothing about this volume is saved or logged.</p>
    <p id="vcm-dialog-http" class="vcm-warning" hidden>Plain HTTP: the password travels unencrypted.</p>
    <!-- Review P1: with "require HTTPS" on, a page opened over plain HTTP offers no
         password field at all, so the password cannot leave the browser. -->
    <p id="vcm-dialog-https" class="vcm-warning" hidden>The setting "Require HTTPS to mount" is on, and this
       page was opened over plain HTTP. <a id="vcm-https-link" href="#">Open this page over HTTPS</a> to unlock,
       or use <code>vcmount</code> over SSH.</p>
    <p id="vcm-pim-warn" class="vcm-warning" hidden>This PIM is very large: unlocking takes many times as long
       as with VeraCrypt's default, and it is stopped after 3 minutes. Check the PIM, or click
       <b>Mount anyway</b>.</p>
    <p id="vcm-mount-error" class="vcm-error" hidden></p>
    <!-- Shown while unlocking: checking a password is slow on purpose. -->
    <div id="vcm-progress" class="vcm-progress" hidden>
      <div class="vcm-progress-head"><i class="fa fa-fw fa-circle-o-notch fa-spin"></i>
        <span id="vcm-progress-text"></span><span id="vcm-progress-time" class="vcm-progress-time"></span></div>
      <div class="vcm-progress-bar"><span id="vcm-progress-fill"></span></div>
      <p id="vcm-progress-note" class="vcm-note"></p>
    </div>
    <div class="vcm-buttons">
      <input type="submit" id="vcm-mount-submit" value="Mount">
      <input type="button" id="vcm-stop-other" value="Stop that unlock" hidden>
      <input type="button" id="vcm-skip" value="Skip" hidden>
      <input type="button" id="vcm-cancel" value="Cancel">
    </div>
  </form>
</div>

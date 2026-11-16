<?php
/*
 * The mount dialog, shared by the Volumes tab and the Dashboard tile, so there
 * is one password form to maintain and review. Markup only: js/vcmount.js
 * gives it its behaviour.
 */
?>
<!-- The mount dialog. A real form with a real password field, so a password
     manager can fill it (UI-4). The hidden user name field holds the volume
     name, so the manager keeps one entry per volume. -->
<div id="vcm-modal" class="vcm-modal" hidden>
  <!-- method, action and onsubmit are a fallback only (review H1): should the
       page script ever fail, a plain form would be sent as GET and put the
       password into the address. With these, it is never sent at all. -->
  <form id="vcm-mount-form" class="vcm-box" autocomplete="on" method="post" action="about:blank" onsubmit="return false">
    <h3 id="vcm-mount-title">Mount</h3>
    <input type="text" id="vcm-user" name="username" autocomplete="username" class="vcm-offscreen" tabindex="-1" readonly>
    <div id="vcm-once-fields" hidden>
      <!-- VOL-5 leaves no trace, so the browser must not remember these either. -->
      <label>Volume file <input type="text" id="vcm-file" placeholder="/mnt/user/..." spellcheck="false" autocomplete="off"></label>
      <label>Name <input type="text" id="vcm-name" maxlength="32" placeholder="letters, digits, - and _" spellcheck="false" autocomplete="off"></label>
      <label class="vcm-check"><input type="checkbox" id="vcm-read-only"> Read-only</label>
      <p class="vcm-note">Nothing about this volume is saved or logged.</p>
    </div>
    <label id="vcm-password-label">Password <input type="password" id="vcm-password" name="password" autocomplete="current-password" required></label>
    <p id="vcm-dialog-http" class="vcm-warning" hidden>Plain HTTP: the password travels unencrypted.</p>
    <!-- Review P1: with "require HTTPS" on, a page opened over plain HTTP offers no
         password field at all, so the password cannot leave the browser. -->
    <p id="vcm-dialog-https" class="vcm-warning" hidden>The setting "Require HTTPS to mount" is on, and this
       page was opened over plain HTTP. <a id="vcm-https-link" href="#">Open this page over HTTPS</a> to unlock,
       or use <code>vcmount</code> over SSH.</p>
    <p id="vcm-mount-error" class="vcm-error" hidden></p>
    <div class="vcm-buttons">
      <input type="submit" id="vcm-mount-submit" value="Mount">
      <input type="button" id="vcm-skip" value="Skip" hidden>
      <input type="button" id="vcm-cancel" value="Cancel">
    </div>
  </form>
</div>

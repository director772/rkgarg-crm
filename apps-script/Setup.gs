/** ============================================================
 * Smart CRM — Setup.gs
 * One function to create/repair all sheets. Safe to run any number
 * of times — never touches existing data, never reorders columns,
 * only adds what's missing.
 * Menu also has the Cloudflare sync items (see CloudflareSync.gs).
 * ============================================================ */

function setupSystem() {
  ensureSheet_(SHEETS.LEADS, LEADS_HEADERS);
  ensureSheet_(SHEETS.CALLLOG, CALLLOG_HEADERS);
  ensureSheet_(SHEETS.USERS, USERS_HEADERS);
  ensureSheet_(SHEETS.LEGACY, LEGACY_HEADERS);
  ensureSheet_(SHEETS.AUDIT, AUDIT_HEADERS);
  ensureSheet_(SHEETS.REQUESTLOG, REQUESTLOG_HEADERS);

  const teamSh = ensureSheet_(SHEETS.TEAM, TEAM_HEADERS);
  if (teamSh.getLastRow() < 2) { // seed only if empty — never overwrite real data on re-run
    teamSh.getRange(2, 1, 3, 2).setValues([['Bhawna', true], ['Dimpy', true], ['Neha', true]]);
  }
  SpreadsheetApp.flush();
  const msg = 'Setup complete. Sheets ready: ' + Object.values(SHEETS).join(', ') +
    '. Now run addUser_() from this editor (Auth.gs) to create logins — see the comment above that function.';
  Logger.log(msg);
  return msg;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Smart CRM')
    .addItem('Run setup / repair sheets', 'setupSystem')
    .addSeparator()
    .addItem('Cloudflare: 1) Sheet ka data app mein copy (sirf pehli baar)', 'cfCopySheetToAppMenu')
    .addItem('Cloudflare: 2) Sync chalu karo (har 5 min + Sheet edit)', 'cfSetupSync')
    .addItem('Cloudflare: Abhi app se Sheet update karo', 'cfPullNowMenu')
    .addToUi();
}

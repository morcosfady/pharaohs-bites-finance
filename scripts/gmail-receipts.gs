/**
 * Pharaoh's Bites: forwards labelled Gmail receipts to the dashboard.
 *
 * Every email that has the Gmail label "PB Receipts" is sent (subject, text and its first PDF/photo
 * attachment) to the receipt-email function, which reads it and files the purchase once.
 * The Gmail Message-ID is the duplicate key, so running this twice never imports an email twice.
 *
 * Setup (one time, in the BUSINESS Gmail): script.google.com > New project > paste this file >
 * Run "setup" once and approve > done. The copy with the token filled in is NOT in the repo.
 */
const ENDPOINT = "https://vvwunhcpxofvnjijemdb.supabase.co/functions/v1/receipt-email";
const TOKEN = "__RECEIPT_INBOX_TOKEN__";
const LABEL = "PB Receipts";
const DONE_LABEL = "PB Receipts/Done";
const OK_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

function setup() {
  GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "importReceipts") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("importReceipts").timeBased().everyMinutes(15).create();
  importReceipts();
}

function importReceipts() {
  const done = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  const threads = GmailApp.search('label:"' + LABEL + '" -label:"' + DONE_LABEL + '"', 0, 20);
  threads.forEach(function (thread) {
    let allOk = true;
    thread.getMessages().forEach(function (msg) {
      try {
        const attachments = msg.getAttachments({ includeInlineImages: false, includeAttachments: true })
          .filter(function (a) { return OK_TYPES.indexOf(a.getContentType()) >= 0 && a.getSize() < 6000000; })
          .slice(0, 1)
          .map(function (a) { return { name: a.getName(), mime: a.getContentType(), data_base64: Utilities.base64Encode(a.getBytes()) }; });
        let text = msg.getPlainBody();
        if (!text) text = msg.getBody().replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        const res = UrlFetchApp.fetch(ENDPOINT, {
          method: "post", contentType: "application/json", muteHttpExceptions: true,
          payload: JSON.stringify({
            token: TOKEN, message_id: msg.getHeader("Message-ID") || msg.getId(), subject: msg.getSubject(),
            from: msg.getFrom(), date: msg.getDate().toISOString(), body_text: String(text).slice(0, 60000), attachments: attachments,
          }),
        });
        if (res.getResponseCode() !== 200) allOk = false;
      } catch (e) { allOk = false; }
    });
    if (allOk) thread.addLabel(done);
  });
}

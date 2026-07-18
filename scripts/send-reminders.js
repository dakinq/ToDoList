const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const MANUAL_RUN = process.env.MANUAL_RUN === 'true';

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const messaging = admin.messaging();

console.log(`Modus: ${MANUAL_RUN ? 'MANUELL' : 'Automatisch (Schedule)'}`);

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function deleteOldCompleted() {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const completedSnap = await db.collection('todos').where('done', '==', true).where('completedAt', '<', cutoff).get();
  const deletedSnap = await db.collection('todos').where('deleted', '==', true).where('deletedAt', '<', cutoff).get();
  let count = 0;
  const batch = db.batch();
  completedSnap.forEach(doc => { batch.delete(doc.ref); count++; });
  deletedSnap.forEach(doc => { batch.delete(doc.ref); count++; });
  if (count > 0) { await batch.commit(); console.log(`${count} To-do(s) endgueltig entfernt.`); }
  else { console.log('Nichts zum endgueltigen Entfernen.'); }
}

// Alle Tokens holen, optional nach E-Mail-Liste filtern
async function getTokens(includeEmails) {
  const snapshot = await db.collection('tokens').get();
  const tokens = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (!includeEmails || includeEmails.includes(data.email)) {
      tokens.push(data.token);
    }
  });
  return tokens;
}

// Alle Tokens holen ausser bestimmte E-Mail
async function getTokensExcept(excludeEmail) {
  const snapshot = await db.collection('tokens').get();
  const tokens = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (!excludeEmail || data.email !== excludeEmail) tokens.push(data.token);
  });
  return tokens;
}

async function sendToTokens(tokens, title, body, todoId) {
  if (tokens.length === 0) { console.log('Keine Tokens zum Senden.'); return { successCount: 0, failureCount: 0 }; }
  console.log(`Sende an ${tokens.length} Token(s)...`);

  const link = todoId
    ? `https://dakinq.github.io/ToDoList/?editId=${todoId}`
    : 'https://dakinq.github.io/ToDoList/';

  // WICHTIG: Bewusst KEIN "notification"-Feld (weder oben noch unter "webpush")!
  // Sobald eine FCM-Nachricht ein "notification"-Feld enthält, zeigt der Browser
  // im Hintergrund automatisch selbst eine Notification an – zusaetzlich zu unserem
  // eigenen showNotification()-Aufruf in onBackgroundMessage(). Das war die Ursache
  // der doppelten Push-Benachrichtigungen. Mit einer reinen "data"-Nachricht bleibt
  // die Anzeige komplett in unserer Hand -> jede Nachricht erscheint nur noch einmal.
  const message = {
    tokens,
    data: {
      title,
      body,
      icon: 'https://dakinq.github.io/ToDoList/icon-192.png',
      link,
    },
  };

  const response = await messaging.sendEachForMulticast(message);
  response.responses.forEach((res, idx) => {
    if (res.success) {
      console.log(`  Token[${idx}] erfolgreich gesendet`);
    } else {
      const errCode = res.error?.code || 'unbekannt';
      const errMsg = res.error?.message || 'keine Message';
      console.error(`  Token[${idx}] Fehler-Code: ${errCode}`);
      console.error(`  Token[${idx}] Fehler-Message: ${errMsg}`);
      const invalidCodes = [
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
        'messaging/invalid-argument',
      ];
      if (invalidCodes.includes(errCode)) {
        console.log(`  Token[${idx}] wird aus Firestore geloescht`);
        db.collection('tokens').doc(tokens[idx]).delete().catch(e => console.error(`Loeschen fehlgeschlagen: ${e.message}`));
      }
    }
  });
  return response;
}

// ---- 1. Erinnerungen fuer faellige To-dos ----
async function sendDueReminders() {
  const today = todayDateString();
  let query = db.collection('todos').where('done', '==', false);
  if (!MANUAL_RUN) query = query.where('notified', '==', false);
  const snapshot = await query.get();

  const dueTodos = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.dueDate && data.dueDate <= today) dueTodos.push({ id: doc.id, ...data });
  });

  if (dueTodos.length === 0) { console.log('Keine faelligen To-dos.'); return; }
  console.log(`${dueTodos.length} faellige To-do(s) gefunden.`);

  for (const todo of dueTodos) {
    const isOverdue = todo.dueDate < today;
    const title = isOverdue ? '\u26a0\ufe0f \u00dcberf\u00e4llig' : '\ud83d\udcc5 Heute f\u00e4llig';

    // Nur an zugewiesene Person(en) senden
    // assignee ist ein einzelner Name (kein Email) – wir senden an alle wenn kein assignee gesetzt
    // oder an alle wenn wir keinen Email-Match machen koennen
    const tokens = await getTokensExcept(null); // alle erhalten Faelligkeits-Erinnerung

    const body = todo.text;
    // Sofort auf true setzen bevor gesendet wird – verhindert Doppel-Push bei parallelen Laeufen
    if (!MANUAL_RUN) await db.collection('todos').doc(todo.id).update({ notified: true });
    try {
      const res = await sendToTokens(tokens, title, body, todo.id);
      console.log(`Faelligkeits-Erinnerung "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
    } catch (e) { console.error(`Fehler bei "${todo.text}":`, e.message); }
  }
}

// ---- 2. Benachrichtigung bei neuen Eintraegen (an alle ausser Autor) ----
async function sendCreationNotifications() {
  const snapshot = await db.collection('todos').where('notifiedCreation', '==', false).get();
  if (snapshot.empty) { console.log('Keine neuen Eintraege zu melden.'); return; }

  for (const doc of snapshot.docs) {
    const todo = doc.data();
    // Sofort auf true setzen bevor gesendet wird – verhindert Doppel-Push bei parallelen Laeufen
    await doc.ref.update({ notifiedCreation: true });
    const tokens = await getTokensExcept(todo.authorEmail || null);
    const title = 'Neuer Eintrag';
    const body = todo.text;
    try {
      const res = await sendToTokens(tokens, title, body, doc.id);
      console.log(`Neuer Eintrag "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
    } catch (e) { console.error(`Fehler bei Neu-Benachrichtigung "${todo.text}":`, e.message); }
  }
}

// ---- 3. Benachrichtigung bei erledigten Eintraegen (an alle ausser wer erledigt hat) ----
async function sendCompletionNotifications() {
  const snapshot = await db.collection('todos').where('notifiedCompletion', '==', false).get();
  if (snapshot.empty) { console.log('Keine neu erledigten Eintraege zu melden.'); return; }

  for (const doc of snapshot.docs) {
    const todo = doc.data();
    // Sofort auf true setzen bevor gesendet wird – verhindert Doppel-Push bei parallelen Laeufen
    await doc.ref.update({ notifiedCompletion: true });
    if (!todo.done) { continue; }
    const tokens = await getTokensExcept(todo.completedByEmail || null);
    const title = 'Erledigt ✓';
    const body = todo.text;
    try {
      const res = await sendToTokens(tokens, title, body, doc.id);
      console.log(`Erledigt "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
    } catch (e) { console.error(`Fehler bei Erledigt-Benachrichtigung "${todo.text}":`, e.message); }
  }
}

async function main() {
  await deleteOldCompleted();
  await sendDueReminders();
  await sendCreationNotifications();
  await sendCompletionNotifications();
}

main().catch(err => { console.error(err); process.exit(1); });

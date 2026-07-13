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

async function getTokensExcept(excludeEmail) {
  const snapshot = await db.collection('tokens').get();
  const tokens = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (!excludeEmail || data.email !== excludeEmail) tokens.push(data.token);
  });
  return tokens;
}

async function sendToTokens(tokens, title, body) {
  if (tokens.length === 0) return { successCount: 0, failureCount: 0 };
  console.log(`Sende an ${tokens.length} Token(s)...`);
  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: { notification: { title, body, icon: 'https://dakinq.github.io/ToDoList/icon-192.png' } }
  });
  response.responses.forEach((res, idx) => {
    if (res.success) {
      console.log(`  Token[${idx}] erfolgreich gesendet`);
    } else {
      const errCode = res.error?.code || 'unbekannt';
      const errMsg = res.error?.message || 'keine Message';
      console.error(`  Token[${idx}] Fehler-Code: ${errCode}`);
      console.error(`  Token[${idx}] Fehler-Message: ${errMsg}`);
      const invalidCodes = ['messaging/registration-token-not-registered','messaging/invalid-registration-token','messaging/invalid-argument'];
      if (invalidCodes.includes(errCode)) {
        console.log(`  Token[${idx}] wird aus Firestore geloescht`);
        db.collection('tokens').doc(tokens[idx]).delete().catch(e => console.error(`  Loeschen fehlgeschlagen: ${e.message}`));
      }
    }
  });
  return response;
}

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
    const title = todo.dueDate < today ? 'Ueberfaellig' : 'Heute faellig';
    const body = todo.text + (todo.assignee ? ' - ' + todo.assignee : '') + (todo.priority ? ' - Prio ' + todo.priority : '');
    const tokens = await getTokensExcept(null);
    try {
      const res = await sendToTokens(tokens, title, body);
      console.log(`Faelligkeits-Erinnerung "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
      if (!MANUAL_RUN) await db.collection('todos').doc(todo.id).update({ notified: true });
    } catch (e) { console.error(`Fehler bei "${todo.text}":`, e.message); }
  }
}

async function sendCreationNotifications() {
  const snapshot = await db.collection('todos').where('notifiedCreation', '==', false).get();
  if (snapshot.empty) { console.log('Keine neuen Eintraege zu melden.'); return; }
  for (const doc of snapshot.docs) {
    const todo = doc.data();
    const tokens = await getTokensExcept(todo.authorEmail || null);
    const title = 'Neuer Eintrag';
    const body = todo.text + (todo.assignee ? ' - fuer ' + todo.assignee : '');
    try {
      const res = await sendToTokens(tokens, title, body);
      console.log(`Neuer Eintrag "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
    } catch (e) { console.error(`Fehler bei Neu-Benachrichtigung "${todo.text}":`, e.message); }
    await doc.ref.update({ notifiedCreation: true });
  }
}

async function sendCompletionNotifications() {
  const snapshot = await db.collection('todos').where('notifiedCompletion', '==', false).get();
  if (snapshot.empty) { console.log('Keine neu erledigten Eintraege zu melden.'); return; }
  for (const doc of snapshot.docs) {
    const todo = doc.data();
    if (!todo.done) { await doc.ref.update({ notifiedCompletion: true }); continue; }
    const tokens = await getTokensExcept(todo.completedByEmail || null);
    const title = 'Erledigt';
    const body = todo.text;
    try {
      const res = await sendToTokens(tokens, title, body);
      console.log(`Erledigt "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
    } catch (e) { console.error(`Fehler bei Erledigt-Benachrichtigung "${todo.text}":`, e.message); }
    await doc.ref.update({ notifiedCompletion: true });
  }
}

async function main() {
  await deleteOldCompleted();
  await sendDueReminders();
  await sendCreationNotifications();
  await sendCompletionNotifications();
}

main().catch(err => { console.error(err); process.exit(1); });

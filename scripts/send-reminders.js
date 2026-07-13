const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const messaging = admin.messaging();

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function deleteOldCompleted() {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const completedSnap = await db.collection('todos')
    .where('done', '==', true)
    .where('completedAt', '<', cutoff)
    .get();

  const deletedSnap = await db.collection('todos')
    .where('deleted', '==', true)
    .where('deletedAt', '<', cutoff)
    .get();

  let count = 0;
  const batch = db.batch();
  completedSnap.forEach(doc => { batch.delete(doc.ref); count++; });
  deletedSnap.forEach(doc => { batch.delete(doc.ref); count++; });

  if (count > 0) {
    await batch.commit();
    console.log(`${count} To-do(s) (erledigt/gelöscht) endgültig entfernt.`);
  } else {
    console.log('Nichts zum endgültigen Entfernen.');
  }
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
    webpush: {
      notification: {
        title,
        body,
        icon: 'https://dakinq.github.io/ToDoList/icon-192.png'
      }
    }
  });

  response.responses.forEach((res, idx) => {
    if (res.success) {
      console.log(`  Token[${idx}] ✓ erfolgreich gesendet`);
    } else {
      // Detailliertes Logging für jeden fehlgeschlagenen Token
      const errCode = res.error?.code || 'unbekannt';
      const errMsg = res.error?.message || 'keine Message';
      console.error(`  Token[${idx}] ✗ Fehler-Code: ${errCode}`);
      console.error(`  Token[${idx}] ✗ Fehler-Message: ${errMsg}`);

      // Ungültige Tokens automatisch löschen
      const invalidCodes = [
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
        'messaging/invalid-argument',
      ];
      if (invalidCodes.includes(errCode)) {
        console.log(`  Token[${idx}] → wird aus Firestore gelöscht`);
        db.collection('tokens').doc(tokens[idx]).delete().catch(e => {
          console.error(`  Token[${idx}] → Löschen fehlgeschlagen: ${e.message}`);
        });
      }
    }
  });

  return response;
}

// ---- 1. Erinnerungen für fällige To-dos ----
async function sendDueReminders() {
  const today = todayDateString();
  const snapshot = await db.collection('todos')
    .where('done', '==', false)
    .where('notified', '==', false)
    .get();

  const dueTodos = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.dueDate && data.dueDate <= today) dueTodos.push({ id: doc.id, ...data });
  });

  if (dueTodos.length === 0) { console.log('Keine fälligen To-dos.'); return; }

  for (const todo of dueTodos) {
    const title = todo.dueDate < today ? '⚠️ Überfällig' : '📅 Heute fällig';
    const body = todo.text + (todo.assignee ? ' · ' + todo.assignee : '') + (todo.priority ? ' · Prio ' + todo.priority : '');
    const tokens = await getTokensExcept(null);
    try {
      const res = await sendToTokens(tokens, title, body);
      console.log(`Fälligkeits-Erinnerung "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
      await db.collection('todos').doc(todo.id).update({ notified: true });
    } catch (e) {
      console.error(`Fehler bei "${todo.text}":`, e.message);
    }
  }
}

// ---- 2. Benachrichtigung bei neuen Einträgen ----
async function sendCreationNotifications() {
  const snapshot = await db.collection('todos')
    .where('notifiedCreation', '==', false)
    .get();

  if (snapshot.empty) { console.log('Keine neuen Einträge zu melden.'); return; }

  for (const doc of snapshot.docs) {
    const todo = doc.data();
    const tokens = await getTokensExcept(todo.authorEmail || null);
    const title = '📝 Neuer Eintrag';
    const body = todo.text + (todo.assignee ? ' · für ' + todo.assignee : '');
    try {
      const res = await sendToTokens(tokens, title, body);
      console.log(`Neuer Eintrag "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
    } catch (e) {
      console.error(`Fehler bei Neu-Benachrichtigung "${todo.text}":`, e.message);
    }
    await doc.ref.update({ notifiedCreation: true });
  }
}

// ---- 3. Benachrichtigung bei erledigten Einträgen ----
async function sendCompletionNotifications() {
  const snapshot = await db.collection('todos')
    .where('notifiedCompletion', '==', false)
    .get();

  if (snapshot.empty) { console.log('Keine neu erledigten Einträge zu melden.'); return; }

  for (const doc of snapshot.docs) {
    const todo = doc.data();
    if (!todo.done) { await doc.ref.update({ notifiedCompletion: true }); continue; }
    const tokens = await getTokensExcept(todo.completedByEmail || null);
    const title = '✅ Erledigt';
    const body = todo.text;
    try {
      const res = await sendToTokens(tokens, title, body);
      console.log(`Erledigt "${todo.text}": ${res.successCount} ok, ${res.failureCount} fehlgeschlagen`);
    } catch (e) {
      console.error(`Fehler bei Erledigt-Benachrichtigung "${todo.text}":`, e.message);
    }
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

const admin = require('firebase-admin');

// Der Service-Account-Schlüssel kommt sicher aus einem GitHub Secret,
// niemals im Code oder Repo gespeichert.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const messaging = admin.messaging();

function todayDateString() {
  const now = new Date();
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function main() {
  const today = todayDateString();

  const snapshot = await db.collection('todos')
    .where('done', '==', false)
    .where('notified', '==', false)
    .get();

  const dueTodos = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.dueDate && data.dueDate <= today) {
      dueTodos.push({ id: doc.id, ...data });
    }
  });

  if (dueTodos.length === 0) {
    console.log('Keine fälligen To-dos.');
    return;
  }

  const tokensSnapshot = await db.collection('tokens').get();
  const tokens = [];
  tokensSnapshot.forEach(doc => tokens.push(doc.data().token));

  if (tokens.length === 0) {
    console.log('Keine registrierten Geräte für Push gefunden.');
    return;
  }

  for (const todo of dueTodos) {
    const title = todo.dueDate < today ? 'Überfällig' : 'Heute fällig';
    const body = todo.text + (todo.assignee ? ' · ' + todo.assignee : '');

    try {
      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body }
      });
      console.log(`Erinnerung gesendet für "${todo.text}": ${response.successCount} erfolgreich, ${response.failureCount} fehlgeschlagen`);

      // Ungültige Tokens (z.B. abgemeldete Geräte) aufräumen
      response.responses.forEach((res, idx) => {
        if (!res.success && res.error && (res.error.code === 'messaging/registration-token-not-registered')) {
          db.collection('tokens').doc(tokens[idx]).delete().catch(() => {});
        }
      });

      await db.collection('todos').doc(todo.id).update({ notified: true });
    } catch (e) {
      console.error(`Fehler beim Senden für "${todo.text}":`, e.message);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

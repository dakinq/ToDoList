importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDfTQHSnhdX5-Z-3MCeDPpDeKXcuEbV1zE",
  authDomain: "todoliste-badfd.firebaseapp.com",
  projectId: "todoliste-badfd",
  storageBucket: "todoliste-badfd.firebasestorage.app",
  messagingSenderId: "764723309146",
  appId: "1:764723309146:web:75a7f9c88264a967c30663"
});

const messaging = firebase.messaging();

// onBackgroundMessage wird nur aufgerufen wenn die App im Hintergrund ist.
// Die Vordergrund-Benachrichtigung wird in index.html via messaging.onMessage() behandelt.
// Server sendet bewusst NUR "data" (kein "notification"-Feld) – siehe send-reminders.js.
// Dadurch zeigt der Browser NICHT automatisch selbst eine Notification an,
// sondern nur genau dieser showNotification()-Aufruf hier. So wird jede
// Nachricht wirklich nur einmal angezeigt.
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = data.title || 'Erinnerung';
  const options = {
    body: data.body || '',
    icon: data.icon || 'icon-192.png',
    badge: 'icon-192.png',
    data: { link: data.link || 'https://dakinq.github.io/ToDoList/' }
  };
  self.registration.showNotification(title, options);
});

// Klick auf die Notification -> bestehendes Fenster fokussieren und zur Task
// navigieren, oder neues Fenster öffnen. Das hat vorher fcm_options.link
// automatisch übernommen; das fällt bei reinen data-Nachrichten weg, daher
// jetzt selbst umgesetzt.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || 'https://dakinq.github.io/ToDoList/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(link);
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(link);
    })
  );
});

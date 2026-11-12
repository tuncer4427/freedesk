'use strict';
// The small "connection request" window. It only shows what the main window
// sends it and reports which button was pressed.
const $ = (id) => document.getElementById(id);
let current = null;

window.fardeskRequest.onShow((data) => {
  current = data.sessionId;
  document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.accent = data.accent || 'green';
  $('from').textContent = data.from;
  $('name').textContent = data.name ? `(${data.name})` : '';
  $('what').textContent = data.control
    ? 'Bu bilgisayarın ekranını görmek ve kontrol etmek istiyor. Yalnızca tanıdığınız kişileri kabul edin.'
    : 'Bu bilgisayarın ekranını görmek istiyor. Yalnızca tanıdığınız kişileri kabul edin.';
  $('waiting').textContent = data.waiting > 0 ? `+${data.waiting} istek daha` : '';
});

const answer = (accept) => () => {
  if (!current) return;
  window.fardeskRequest.answer(current, accept);
  current = null;
};
$('accept').addEventListener('click', answer(true));
$('reject').addEventListener('click', answer(false));

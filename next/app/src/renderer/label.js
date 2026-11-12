'use strict';
// Name tag shown next to the pointer while someone controls this computer.
window.setLabel = (text) => {
  document.getElementById('label').textContent = String(text).slice(0, 48);
};

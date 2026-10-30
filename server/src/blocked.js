'use strict';

// Elenco volutamente breve: solo parole inequivocabili, cercate come sottostringa nel nome "ripulito".
// Evitiamo parole che compaiono dentro nomi e cognomi comuni (es. "troia" in "Troiano").
// Per tutto il resto c'è lo strumento di amministrazione (scripts/admin.js remove-user).
const BLOCKED = [
  'cazzo', 'merda', 'stronz', 'vaffanc', 'puttan', 'minchia', 'frocio', 'ricchione', 'pedofil',
  'fuck', 'shit', 'bitch', 'cunt', 'whore', 'faggot', 'nigger', 'nigga', 'pedophil', 'hitler',
];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i', '|': 'i' };

// Minuscolo, senza accenti, cifre "da hacker" sostituite, solo lettere: "Ciao M3rd@" -> "ciaomerda".
function squash(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[01345 7@$!|]/g, c => LEET[c] || '')
    .replace(/[^a-z]/g, '');
}

function isBlockedName(name) {
  const s = squash(name);
  return BLOCKED.some(w => s.includes(w));
}

module.exports = { isBlockedName, squash };

# Sudoku: pubblicazione su sudoku.vivievegeti.it

## Struttura

```
public/          il gioco, apribile anche con doppio clic (offline: senza classifica)
  index.html     struttura della pagina
  style.css      stili
  sudoku-core.js generatore e risolutore (condiviso con il server)
  online.js      profilo, accesso, classifica, invio dei tempi
  app.js         gioco, statistiche, tutorial
  privacy.html   informativa (da completare, vedi sotto)
server/          API Node (Fastify) + test + strumento di amministrazione
Dockerfile       immagine del container "sudoku" (gioco + API, porta 3000)
docker-compose.yml   container "sudoku" + Redis dedicato "sudoku_redis"
deploy/nginx-sudoku.conf   le modifiche da fare al proxy della VPS
.env.example     segreti da impostare
```

## Prima installazione sulla VPS

1. **DNS (Cloudflare)**: record `sudoku` (A o CNAME verso la VPS) con nuvola arancione, come gli altri sottodomini.
   Il certificato Origin del proxy (`*.vivievegeti.it`) lo copre già.
2. **Segreti**: copia `.env.example` in `.env` e compilalo (comando di generazione nel file).
   Conserva una copia di `SUDOKU_SECRET`: se si perde o cambia, nessun utente può più accedere.
3. **Proxy**: applica i tre pezzi di `deploy/nginx-sudoku.conf` e ricarica nginx
   (`docker exec global_proxy nginx -t && docker exec global_proxy nginx -s reload`).
4. **Informativa privacy**: in `public/privacy.html` sostituisci i campi evidenziati in rosso
   (`[NOME E COGNOME O RAGIONE SOCIALE]`, `[EMAIL DI CONTATTO]`, `[DATA]`) e fai rileggere il testo a chi ne sa:
   è una bozza, non una consulenza legale.
5. **Avvio**: `docker compose up -d --build` nella cartella del progetto.
   Il container `sudoku` entra nella rete esterna `web-gateway` (deve già esistere, come per le altre app).
6. **Verifica**: `https://sudoku.vivievegeti.it/api/health` deve rispondere `{"ok":true}`.

## Aggiornamenti

`git pull && docker compose up -d --build`. I dati stanno nel volume `sudoku_redis_data`, che non viene toccato.

## Moderazione

Alla registrazione un piccolo elenco di parole inequivocabili viene rifiutato (`server/src/blocked.js`).
Per rimuovere un utente (profilo, sessioni, punteggi in tutte le classifiche) o vedere la classifica:

```
docker exec sudoku node server/scripts/admin.js remove-user "Nome"
docker exec sudoku node server/scripts/admin.js top easy
```

## Redis

- È dedicato (non usa `shared_redis`, che ha `allkeys-lru` e nessuna persistenza: perderebbe la classifica).
- Persistenza AOF, nessuna eliminazione automatica, raggiungibile solo dal container `sudoku`.
- **Backup**: copia periodicamente il volume (es. `docker run --rm -v sudoku_redis_data:/data -v $PWD:/b alpine tar czf /b/sudoku-redis.tgz /data`).

## Sicurezza

- Il server invia una **Content-Security-Policy** molto stretta: niente script o stili inline, nessuna risorsa esterna.
  Quando aggiungeremo la pubblicità andrà allargata ai domini dell'ad network (`server/src/app.js`, costante `CSP`).
- L'IP dei visitatori arriva da Cloudflare tramite `CF-Connecting-IP`: serve il blocco `set_real_ip_from` in
  `deploy/nginx-sudoku.conf`, altrimenti i limiti per IP vedrebbero tutti gli utenti come un solo indirizzo.
- PIN a 6 cifre: dopo 5 errori consecutivi l'account si blocca per 15 minuti; limiti per IP su registrazioni, accessi e partite.
- Il token di accesso sta nel `localStorage` del browser; la CSP riduce il rischio che uno script estraneo lo legga.

## Cloudflare: impostazioni consigliate

- SSL/TLS in modalità **Full (strict)**.
- Regola di cache: **bypass** per `sudoku.vivievegeti.it/api/*`.
- Quando metteremo gli annunci: lasciare **disattivati** Rocket Loader e minificazione JavaScript.

## Test

Servono Node 20+ e un Redis di prova:

```
docker run -d --rm --name sudoku_test_redis -p 127.0.0.1:63790:6379 redis:7-alpine
cd server && npm install && npm test
docker stop sudoku_test_redis
```

## Dati personali

L'email non viene salvata: si conserva solo un hash (HMAC con `SUDOKU_SECRET`). Il PIN è salvato come hash scrypt.
Non è quindi possibile recuperare un PIN dimenticato né scrivere agli utenti. Dal gioco l'utente può eliminare il
profilo (`DELETE /api/me`): cancella nome, PIN, sessioni e punteggi.

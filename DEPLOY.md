# Sudoku: pubblicazione su sudoku.vivievegeti.it

## Struttura

```
public/          il gioco (index.html + sudoku-core.js): apribile anche con doppio clic, senza server
server/          API Node (Fastify) + test; usa lo stesso sudoku-core.js del browser
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
4. **Avvio**: `docker compose up -d --build` nella cartella del progetto.
   Il container `sudoku` entra nella rete esterna `web-gateway` (deve già esistere, come per le altre app).
5. **Verifica**: `https://sudoku.vivievegeti.it/api/health` deve rispondere `{"ok":true}`.

## Aggiornamenti

`git pull && docker compose up -d --build`. I dati stanno nel volume `sudoku_redis_data`, che non viene toccato.

## Redis

- È dedicato (non usa `shared_redis`, che ha `allkeys-lru` e nessuna persistenza: perderebbe la classifica).
- Persistenza AOF, nessuna eliminazione automatica, raggiungibile solo dal container `sudoku`.
- **Backup**: copia periodicamente il volume (es. `docker run --rm -v sudoku_redis_data:/data -v $PWD:/b alpine tar czf /b/sudoku-redis.tgz /data`).

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
Non è quindi possibile recuperare un PIN dimenticato né scrivere agli utenti. `DELETE /api/me` cancella profilo,
sessioni e punteggi.

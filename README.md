# oc-report-photos

Caché de las fotos de evidencia de los reportes de OC Clean Masters. Guarda en disco una copia de las fotos que sirve el Apps Script (las originales siguen en Google Drive) para que la página del reporte las cargue rápido.

Publicado con Coolify en `https://photos.northmasters.ca`.

## Endpoints

| Método | Ruta | Uso |
| --- | --- | --- |
| `POST` | `/warm` | Header `X-Warm-Token`, body `{ "task_id", "k" }`. Responde 202 y baja las fotos en segundo plano. |
| `GET` | `/api/report?t=<task_id>&k=<k>` | `{ ok, cached:true, reference, date, description, videos, photos:[{url,mime,kb}] }`, o `{ ok, cached:false }` y arranca el warm. |
| `GET` | `/files/<task_id>_<k>/<nn>.<ext>` | La foto, con caché de un año e `immutable`. |
| `GET` | `/health` | `ok` |

`k = base64url(HMAC_SHA256(REPORT_SECRET, task_id))` cortado a 16 caracteres.

## Variables de entorno

Ver `.env.example`. `REPORT_SECRET` y `WARM_TOKEN` se configuran solo en Coolify. `DATA_DIR` (`/data`) debe ser un volumen persistente.

## Límites

- 3 fotos a la vez por warm y 2 warms a la vez en todo el servicio (cuota de Apps Script).
- Cada llamada a Apps Script se reintenta hasta 5 veces.
- Una vez al día se borran las carpetas con más de `RETENTION_DAYS` días.

## Correr en local

```bash
docker build -t oc-report-photos .
docker run --rm -p 3000:3000 --env-file .env -v "$PWD/data:/data" oc-report-photos
```

# Trivia UTS · PWA

PWA (HTML, CSS y JavaScript puro) que consume la API de `https://userapi-m8ef.onrender.com`.
Funciona como *single page application*: un solo `index.html` y un router por hash (`#/inicio`, `#/admin/preguntas`, …).

```
index.html            App shell (barra, pestañas, contenedor de vistas)
app.css               Estilos
app.js                Router, cliente de la API, manejador de errores y vistas
sw.js                 Service worker (caché del shell y de las lecturas de la API)
manifest.webmanifest  Datos de instalación
icon-192.png / icon-512.png
```

## Roles

| Rol | Pantallas |
| --- | --- |
| **ADMIN** | CRUD de usuarios, materias y preguntas con respuestas (tablas paginadas) |
| **USER** | Mi progreso (score general, score por materia, últimos scores), elegir partida (una materia o mixto), jugar y ver el resultado |

El rol se obtiene de `GET /api/Auth/GetSession` después del login. No hay registro ni recuperación de contraseña: los usuarios los crea el administrador.

## Service worker

- **App shell** (`index.html`, `app.css`, `app.js`, iconos): *stale-while-revalidate*. Abre al instante desde la caché y descarga la versión nueva en segundo plano (se ve en la siguiente recarga).
- **API (solo GET)**: *network-first*. Cada lectura se guarda; si no hay red se responde con la última copia y la app muestra un aviso con la fecha de esos datos.

Pantallas que funcionan sin conexión (con lo que ya se haya consultado antes):

1. **Mi progreso** (jugador)
2. **Jugar** (lista de materias) y la **partida** con las preguntas guardadas
3. **Usuarios / Materias / Preguntas** del admin (solo lectura)

Si se termina una partida sin conexión, el score queda pendiente y se envía solo al reconectar.
Al cerrar sesión se borra la caché de la API.

## Manejo de errores

`handleError()` en `app.js` traduce cualquier respuesta de la API a un mensaje claro:

- Validaciones de ASP.NET (`errors: { Campo: [...] }`): se marcan los campos del formulario.
- Reglas de la BD (`P0409: mensaje`): se muestra el mensaje sin el código.
- Errores genéricos en inglés (`Unexpected error during ...`): se traducen.
- Errores de PostgreSQL (`23505`, `22P02`, …): mensaje entendible + código.
- Sin red, tiempo agotado y servidor dormido (Render tarda hasta ~1 min en despertar).
- `401`: cierra la sesión.

## Probar localmente

El service worker necesita `localhost` o HTTPS:

```bash
python -m http.server 5500
```

Abrir `http://localhost:5500`.

## Despliegue gratuito: GitHub Pages

El repositorio ya está en GitHub (`xCorick/AppShellPWA`), así que GitHub Pages es lo más directo: gratis, con HTTPS (requisito del service worker) y sin configuración extra. Todas las rutas de la app son relativas, por lo que funciona dentro de la subcarpeta `/AppShellPWA/`, y el archivo `.nojekyll` evita que GitHub procese los archivos.

1. Subir los cambios a la rama `main`.
2. En GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Elegir **Branch: `main`** y carpeta **`/ (root)`**, y guardar.
4. En un par de minutos queda en `https://xcorick.github.io/AppShellPWA/`.

Alternativas igual de gratuitas: Netlify (arrastrar la carpeta en app.netlify.com/drop), Cloudflare Pages o Vercel; ninguna necesita build.

Al publicar una versión nueva conviene cambiar `SHELL_CACHE` en `sw.js` (`trivia-shell-v2`, …) para que los usuarios reciban todos los archivos nuevos de una vez.

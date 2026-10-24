# SF Sidekick — Agent Hackathon 2026

A mobile-first web app that turns a visitor's goal in San Francisco into relevant people, useful conversations, and a daily plan. See the [product and implementation plan](SF-Sidekick-Implementation-Plan.md) for scope and acceptance criteria.

## Estado: fase 1 — onboarding por conversación

El onboarding es un chat con una única entrada de texto. OpenAI recibe la conversación y el borrador actual, extrae varios datos de un mensaje y devuelve una respuesta breve junto a un perfil estructurado. El asistente tiene instrucciones de preguntar solo por lo que falta y de aceptar correcciones en lenguaje natural. No hay categorías que seleccionar, pasos de formulario ni un parser local que simule conversación.

El perfil recoge objetivo, nombre, experiencia, aportación, fechas, disponibilidad, compromisos y preferencias. Un resumen se completa junto al chat (desplegable en móvil). «Revisar mi perfil» permite comprobarlo y «Confirmar perfil» lo guarda como contexto confirmado. Escribir «sí» en el chat no sustituye esa acción. Disponibilidad desconocida y ausencia de compromisos siguen siendo estados distintos; horarios y presupuesto pueden definirse después.

La conversación y su borrador persisten por sesión, separados del perfil confirmado. Reintentos, fallos de proveedor y conflictos entre pestañas conservan los datos. Los perfiles guardados con la versión anterior se recuperan al abrir el chat.

**Conexión real pendiente:** la interfaz, API, extracción estructurada y persistencia están implementadas. No se ha realizado una llamada real a OpenAI porque el propietario añadirá la key después. Las pruebas automatizadas usan una respuesta de proveedor simulada y no demuestran la calidad lingüística del modelo. Sin key, la UI muestra «OpenAI por conectar» y no inventa respuestas.

Las siguientes fases son descubrimiento/ranking con evidencia y autenticación/matching bilateral. Aún no hay recomendaciones, presentaciones, registro en eventos ni escrituras de calendario. El onboarding tampoco otorga esos permisos.

## Desarrollo local

```bash
npm ci
[ -f .env.local ] || cp .env.example .env.local
npm run dev
```

Abre http://127.0.0.1:3000. Node 22.13 o posterior; desarrollado y comprobado con Node 26. El servidor escucha solo en loopback.

La base usa Next.js, TypeScript, Zod y SQLite. `DATABASE_PATH` permite cambiar el archivo, por defecto `./data/sidekick.sqlite`; consulta `.env.example`. Ejecutar una sola instancia Node con disco persistente. El archivo local no es compatible con funciones de disco efímero.

Si ya existe `.env.local`, edítalo sin sobrescribirlo. Añade `OPENAI_API_KEY` y, opcionalmente, `OPENAI_MODEL` (por defecto `gpt-5.4-mini`); reinicia el servidor. La key solo se lee en servidor y nunca usa un prefijo `NEXT_PUBLIC_`. La conversación se envía a OpenAI para interpretar el contexto; se utiliza Responses API con `store: false`, salida estructurada y Zod. Véase [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

La sesión anónima usa una cookie HttpOnly y datos aislados; no es un login ni una identidad verificada para realizar introducciones. Mantener esta fase en local. El login y OAuth de Google llegan antes de activar matching entre personas reales.

## Verificación

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm start
```

Las pruebas cubren fechas de SF (incluidos cambios horarios), restricciones, confirmación, aislamiento, revisiones, reintentos y recuperación de SQLite. `GET /api/onboarding` recupera conversación/configuración; `POST /api/onboarding` admite `message`, `confirm` y `reload_saved`. El cliente no puede enviar un borrador ni elegir otra identidad. `GET /api/state` y `POST /api/context` siguen disponibles para el contexto confirmado. Las respuestas personales no usan caché compartida.

Para las pruebas de navegador:

```bash
npx playwright install chromium
npm run test:e2e
```

Playwright levanta la app en `127.0.0.1:3100` con SQLite temporal y un proveedor HTTP de prueba en `127.0.0.1:3101`. La key y `OPENAI_BASE_URL` de prueba solo se inyectan en ese proceso: ninguna llamada sale a OpenAI. Se ejercitan SDK, API, persistencia y navegador reales; el contenido lingüístico viene de `tests/e2e/mock-openai.mjs`, que no es un fallback de la app.

Detén antes cualquier `next dev` de este repositorio. `PREVIEW_DIR=/ruta/absoluta` guarda capturas marcadas como fixtures. Verificado en Chromium a 320, 390 y 1280 px; no en teclado/safe areas de un teléfono físico.

### Auditoría A1 de esta entrega

| Comprobación | Evidencia |
| --- | --- |
| Revisar y corregir por chat antes de confirmar | Recorrido con proveedor simulado en `tests/e2e/onboarding.spec.ts` |
| Rechazar fechas/horarios inválidos y confirmación ausente | Pruebas de dominio y API |
| Conservar estado y cambiar objetivo con nueva revisión | Recarga y edición en navegador; reapertura de SQLite en `tests/store.test.ts` |
| No duplicar al perder una respuesta | Reintento del mismo `requestId`, sin repetir llamada al proveedor |
| No sobrescribir una edición más reciente | Conflicto de revisión y elección explícita de versión |
| No mezclar datos de navegadores | Dos sesiones diferentes en pruebas de almacén y API |

SQLite conserva el borrador en `onboarding_chats` y registra turnos/confirmaciones aceptados en `runs`, ligados a sesión, operación y revisión. El modelo no tiene herramientas para escribir el perfil, enviar intros ni modificar calendarios. Antes de considerar verificada la extracción real, añadir una key y comprobar: varios datos en un párrafo, «no contrato, busco trabajo», fechas ambiguas y correcciones posteriores.

El plan describe el producto completo; sus funciones futuras no se consideran implementadas por aparecer en el documento.

## Project skills

Three focused skills live in `.agents/skills`. Load the skill relevant to the work; supporting product details stay in the implementation plan.

| Skill | Use it for | Origin |
| --- | --- | --- |
| [sf-sidekick-mobile-first](.agents/skills/sf-sidekick-mobile-first/SKILL.md) | Phone-first onboarding, opportunity cards, preparation, daily plan, and responsive interaction states | Custom for this project |
| [sf-sidekick-core](.agents/skills/sf-sidekick-core/SKILL.md) | Evidence-backed matching, domain contracts, reliable plan changes, and focused acceptance checks | Custom for this project |
| [web-design-guidelines](.agents/skills/web-design-guidelines/SKILL.md) | UI and accessibility review of implemented screens | Vercel, discovered on [skills.sh](https://skills.sh/vercel-labs/agent-skills/web-design-guidelines) |

Codex discovers these project-local skills automatically. They can also be invoked explicitly, for example: “Use $sf-sidekick-mobile-first to build the opportunity screen.” See [skill discovery](https://learn.chatgpt.com/docs/customization/overview#skills).

The Vercel skill is copied unchanged from [`vercel-labs/agent-skills` at `063bee94c3f4df8453406c830b0a7df0f2860278`](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines/SKILL.md), retrieved on 2026-10-24. The upstream repository declares [MIT licensing](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/README.md#license). Its review rules are fetched at use time, so those rules are not pinned. In Codex, use the available web-fetch tool for its `WebFetch` step; disclose unavailable rules if the fetch fails.

These skills add instructions only; they introduce no application dependencies or services.

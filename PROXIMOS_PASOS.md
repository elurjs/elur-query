# Proximos Pasos de Elur Query

Este documento define el plan de evolucion para `@elurjs/query` siguiendo una convencion CQRS clara:

- Lectura: `createQuery`
- Escritura: `createCommand`

## Roadmap

Estado actual:

- v1.1: completada
- v1.2: completada
- v1.3: completada (experimental)
- v1.4: completada (reactive params, cache helpers con params, effective key)
- v1.5: completada (single-flight, dispose, keepPreviousData/placeholderData, stableStringify robusto)

### v1.1

`createCommand` minimo, robusto y sin optimistic updates.

#### Contrato concreto v1.1

- Estado: `idle | pending | success | error`
- API: `execute`, `executeAsync`, `reset`, `cancel`
- Concurrencia: `mode: "latest" | "queue" | "parallel"`
- Proteccion movil: `dedupeWindowMs`
- Integracion query: `invalidate` al `onSuccess` o `onSettled`
- Retry: `retry` y `retryDelay`, con guia oficial por tipo de error

### v1.2

Cache writes + optimistic/rollback explicito.

#### Contrato concreto v1.2

- Agregar `getQueryData`, `setQueryData`, `updateQueryData`
- `onMutate` devuelve `context` con `previousData`
- Rollback explicito con `setQueryData(key, context.previousData)`
- Documentar colisiones de comandos optimistas simultaneos y orden de rollback

### v1.3

Offline queue como experimental.

#### Contrato concreto v1.3

- Marcar explicitamente como `advanced/experimental`
- Requisitos backend: idempotency real en servidor
- Requisitos cliente: payload serializable, politica de replay y storage definido
- Integracion solo mediante adaptador (sin storage opinionated dentro del core)

Implementado en v1.3:

- Nuevo `mode: "queueOffline"` en `createCommand`
- Estado extendido: `queued`
- Nuevas señales/metodos: `queuedCount`, `isQueued`, `replayQueue`, `clearQueue`
- Error explicito para cola offline: `CommandQueuedError`
- Contrato de adaptador obligatorio para persistencia:
	- `enqueue(entry)`
	- `list(commandKey?)`
	- `update(entry)`
	- `remove(id)`
- Hooks de ciclo offline:
	- `onEnqueue`
	- `onReplaySuccess`
	- `onReplayError`
	- `shouldEnqueue` (defer por politica)

Nota de diseno:

- El core no asume `localStorage`, `IndexedDB` ni plugins moviles.
- Cada app define su propia estrategia de cola con un adaptador.

### v1.5

Hardening: single-flight, dispose, keepPreviousData/placeholderData, stableStringify robusto.

#### Contrato concreto v1.5

- Single-Flight Request Deduplication:
  - Mapa global `_inflightRequests` compartido por key.
  - Dos o mas componentes montando la misma key con cache vacio disparan un solo fetch.
  - `invalidateQueries` y `clearQueryCache` limpian el mapa inflight.
  - `refetch()` bypassa el single-flight para forzar una peticion nueva.
- `dispose()` en `createQuery` y `createCommand`:
  - Remueve listeners globales (`online`).
  - Cancela requests en vuelo.
  - Limpia registros globales (`_queryRegistry`, `_querySyncRegistry`, `_globalCommandQueues`, `_globalLatestControllers`, `_globalReplayLocks`).
  - Detiene el tracking de signals de params.
  - Idempotente.
- `keepPreviousData` y `placeholderData` en `createQuery`:
  - `keepPreviousData`: mantiene la data anterior visible durante el refetch.
  - `placeholderData`: muestra un valor estatico o calculado cuando no hay cache.
  - `keepPreviousData` tiene prioridad cuando ya hay data previa.
- `_stableStringify` robusto:
  - `Date` serializado via `.toISOString()` (UTC, timezone-safe).
  - `Map` y `Set` serializados con orden deterministico.
  - Referencias circulares lanzan `TypeError` en vez de stack overflow.
- `serializeParams` custom en `createQuery` y cache helpers.

## Matriz de Retry Recomendada

- Errores 4xx de negocio/validacion: no retry
- Errores 5xx y fallos transitorios de red: retry acotado

Patron oficial recomendado:

```ts
retry: (count, err) => isTransient(err) && count < 3
```

Donde `isTransient(err)` debe mapear de forma explicita estados HTTP y errores de red.

## Resumen de Decision

- Esta estrategia reduce riesgo de scope y evita complejidad prematura.
- La decision correcta es entregar valor fuerte en v1.1 y v1.2.
- v1.3 debe mantenerse opcional/experimental hasta tener un caso real que guie el diseno.

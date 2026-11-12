# FECP POS — imagen de producción
# Node 22 = la misma versión mayor que se usa en desarrollo (v22.17.1).
# Dos etapas: compilar (necesita las dependencias de desarrollo) y ejecutar (solo lo indispensable).

# ---------- Etapa 1: compilar ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# NODE_OPTIONS limita solo el montón de JavaScript del build (el servidor comparte RAM con n8n y no tiene swap).
# No limita la memoria nativa de Turbopack; ver DEPLOY.md (sección de memoria).
ENV NEXT_TELEMETRY_DISABLED=1 \
    BUILD_STANDALONE=1 \
    NODE_OPTIONS=--max-old-space-size=1536
# Sin ARG ni secretos: el build no necesita ninguna variable de entorno. Las reales se leen al ARRANCAR, no aquí.
RUN npm run build

# ---------- Etapa 2: ejecutar ----------
FROM node:22-alpine AS run
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    TZ=America/Bogota

# Base de datos de zonas horarias (Alpine no la trae) para que TZ=America/Bogota funcione en el sistema
RUN apk add --no-cache tzdata

# Servidor autocontenido de Next (incluye pg, bcryptjs, jose y qrcode, que la app ya usa)
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Scripts de base de datos (db:setup / db:seed). Usan "pg" (ya incluido) y "bcryptjs".
# bcryptjs NO viene en el servidor autocontenido (Next lo empaqueta dentro de su código), así que se copia aparte;
# es JavaScript puro y no tiene dependencias.
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/node_modules/bcryptjs ./node_modules/bcryptjs

# Sin root dentro del contenedor
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

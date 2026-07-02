# Intlaqa backend — production image for Hugging Face Spaces (Docker SDK).
# HF Spaces REQUIRE the app to listen on port 7860 and bind 0.0.0.0.
FROM node:20-alpine

WORKDIR /app

# Production deps only, cached layer.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

COPY . .

ENV NODE_ENV=production
# HF Spaces always exposes 7860. The app also reads PORT from the environment.
ENV PORT=7860

EXPOSE 7860

CMD ["node", "src/server.js"]

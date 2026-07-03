# Servis imajı — backend'in kendisi. Docker'ın OLMADIĞI ortamlar
# (Render / Railway / Fly.io) için SANDBOX=local modda çalışır:
# g++ imajın içindedir, kullanıcı kodu bu konteynerin içinde ulimit'lerle koşar.
# Dış izolasyonu platformun konteyneri/microVM'i sağlar.
#
#   docker build -t cpp-pratik-backend backend
#   docker run --rm -p 8080:8080 cpp-pratik-backend
FROM node:20-bookworm-slim

# g++: kullanıcı kodunu derlemek için (çalışma zamanında gerekli)
# make/python3: node-pty'nin native derlemesi için (npm install sırasında)
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ make python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js sandbox.js ./

ENV NODE_ENV=production \
    SANDBOX=local \
    PORT=8080

# Kullanıcı kodu da bu kullanıcıyla çalışacak — root olmasın
USER node
EXPOSE 8080
CMD ["node", "server.js"]

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
ENV VIDEOCALL_CLOUD=1
ENV VIDEOCALL_TUNNEL=0
ENV VIDEOCALL_LOCAL_HTTPS=0
EXPOSE 3000
CMD ["npm", "start"]

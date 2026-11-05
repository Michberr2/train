FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app/browser-host
COPY browser-host/package.json browser-host/package-lock.json ./
RUN npm ci --ignore-scripts && mkdir /data && chown pwuser:pwuser /data
COPY browser-host/adapter.mjs browser-host/proxy.mjs ./
COPY browser-device /app/browser-device
USER pwuser
ENV PORT=8877 BROWSER_DATA_DIR=/data NALU_DEVICE_CONTAINER=1
EXPOSE 8877
CMD ["node","/app/browser-device/server.mjs"]

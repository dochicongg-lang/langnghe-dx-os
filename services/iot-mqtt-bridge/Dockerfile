# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Làng Nghề Số contributors
FROM node:22-alpine
WORKDIR /app/services/iot-mqtt-bridge
ENV NODE_ENV=production
COPY services/trace-api/devices.js /app/services/trace-api/devices.js
COPY services/trace-api/iot-signing.js /app/services/trace-api/iot-signing.js
COPY services/trace-api/mqtt-protocol.js /app/services/trace-api/mqtt-protocol.js
COPY services/trace-api/iot.js /app/services/trace-api/iot.js
COPY services/iot-mqtt-bridge/bridge.js ./bridge.js
USER node
CMD ["node", "bridge.js"]

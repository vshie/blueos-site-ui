# BlueOS extension: Grafana (provisioned) + MQTT relay/device control page.
# Platforms: linux/arm/v7 (Pi 3B+ / Pi 4 32-bit), linux/arm64/v8 (Pi 4 64-bit / Pi 5), linux/amd64
#
# Grafana = graphs/history only. The control page (Node + MQTT.js) is the
# primary HMI: it emulates Home Assistant-style entity cards over plain MQTT,
# with no add-on/integration required on the broker side.

FROM grafana/grafana-oss:11.3.0

ARG IMAGE_NAME=site-ui
ARG AUTHOR="Tony White"
ARG AUTHOR_EMAIL="tony@bluerobotics.com"
ARG MAINTAINER="Tony White"
ARG MAINTAINER_EMAIL="tony@bluerobotics.com"
ARG REPO=vshie/blueos-site-ui
ARG OWNER=vshie

USER root

RUN apk add --no-cache nodejs npm curl \
 && mkdir -p /etc/grafana/dashboards

WORKDIR /app/control-ui
COPY control-ui/package.json control-ui/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY control-ui/server.js control-ui/devices.seed.json ./
COPY control-ui/public ./public

COPY grafana/provisioning /etc/grafana/provisioning
COPY grafana/dashboards /etc/grafana/dashboards

COPY entrypoint.sh /blueos-entrypoint.sh
RUN chmod +x /blueos-entrypoint.sh \
 && mkdir -p /var/lib/grafana && chown -R 472:472 /var/lib/grafana

# Grafana defaults: anonymous Admin for LAN v0.1 (documented in README). Change
# GF_AUTH_ANONYMOUS_ENABLED=false to require the default admin/admin login.
# GF_SECURITY_ALLOW_EMBEDDING lets the control page (port 80) iframe the
# provisioned dashboard from Grafana (port 3000) — different ports are
# different origins, so Grafana's default X-Frame-Options/CSP would
# otherwise block the embed.
ENV GF_SERVER_HTTP_PORT=3000 \
    GF_PATHS_PROVISIONING=/etc/grafana/provisioning \
    GF_AUTH_ANONYMOUS_ENABLED=true \
    GF_AUTH_ANONYMOUS_ORG_ROLE=Admin \
    GF_AUTH_DISABLE_LOGIN_FORM=false \
    GF_SECURITY_ALLOW_EMBEDDING=true \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false \
    MQTT_HOST=host.docker.internal \
    MQTT_PORT=1883 \
    MQTT_ROOT=blueos \
    CONTROL_PORT=80 \
    GRAFANA_PORT=3000

EXPOSE 80/tcp 3000/tcp

LABEL version="0.4.0"
LABEL type="other"
LABEL tags='["grafana","mqtt","esphome","control","relay","dashboard","home-automation"]'
LABEL requirements="core >= 1.1"

LABEL permissions='\
{\
  "ExposedPorts": {\
    "80/tcp": {},\
    "3000/tcp": {}\
  },\
  "HostConfig": {\
    "ExtraHosts": ["host.docker.internal:host-gateway"],\
    "PortBindings": {\
      "80/tcp": [{"HostPort": ""}],\
      "3000/tcp": [{"HostPort": "3000"}]\
    },\
    "Binds": [\
      "/usr/blueos/extensions/site-ui:/var/lib/grafana"\
    ]\
  }\
}'

LABEL authors='[{"name": "Tony White", "email": "tony@bluerobotics.com"}]'
LABEL company='{\
  "about": "Grafana + HA-style MQTT relay/device control page for BlueOS site stacks",\
  "name": "Community",\
  "email": "tony@bluerobotics.com"\
}'
LABEL readme="https://raw.githubusercontent.com/${REPO}/{tag}/README.md"
LABEL links='{\
  "source": "https://github.com/vshie/blueos-site-ui",\
  "documentation": "https://github.com/vshie/blueos-site-ui/blob/main/README.md"\
}'

LABEL org.blueos.image-name="${IMAGE_NAME}"
LABEL org.blueos.authors="[{\"name\": \"${AUTHOR}\", \"email\": \"${AUTHOR_EMAIL}\"}]"
LABEL org.blueos.company="{\"about\": \"Grafana + MQTT device control for BlueOS\", \"name\": \"${MAINTAINER}\", \"email\": \"${MAINTAINER_EMAIL}\"}"

ENTRYPOINT ["/blueos-entrypoint.sh"]

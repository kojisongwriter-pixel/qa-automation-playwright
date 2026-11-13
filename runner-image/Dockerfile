# AssureLayer four-browser runner image.
#
# Everything a dispatched AssureLayer run used to install on every run —
# the Linux packages of the four browsers, Playwright's Firefox, WebKit and
# FFmpeg builds, branded Google Chrome and Microsoft Edge — plus the Node.js
# version of the client workflow. Contents come only from upstream sources:
# the Ubuntu base image (pinned by digest), Node.js release archives from
# nodejs.org (verified against the release's SHASUMS256.txt), and Playwright's
# own installer at the project's pinned version (which installs branded Chrome
# from dl.google.com and Edge from packages.microsoft.com). No project source,
# token or secret is copied into the image.
#
# Built, validated and published by .github/workflows/runner-image.yml. Client
# workflows use it only by immutable digest, updated through a reviewed change.

FROM ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5

# Must match the client workflow (Node 26) and package-lock.json (@playwright/test).
# 26.13.1 is the Node 26 security release of 2026-11-10.
ARG NODE_VERSION=26.13.1
# npm bundled with Node 26.13.x is 11.20.0, which ships undici 6.28.0 and brace-expansion 5.0.9
# (CVE-2026-19534, -87018, -109383, -109869; CVE-2026-102276, -102278). 11.21.2 — same major —
# bundles undici 6.29.1 and brace-expansion 5.0.12, the fixed versions.
ARG NPM_VERSION=11.21.2
ARG PLAYWRIGHT_VERSION=1.61.0
ARG BUILD_DATE=unknown
ARG SOURCE_COMMIT=unknown

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils git libatomic1 \
 && rm -rf /var/lib/apt/lists/*

# Node.js release archive, checked against the release's published SHA-256 list.
RUN set -eu; \
    cd /tmp; \
    file="node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${file}"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " ${file}\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "${file}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "${file}" SHASUMS256.txt; \
    npm install -g "npm@${NPM_VERSION}"; \
    rm -rf /root/.npm; \
    node --version; npm --version

# The four browsers and their OS packages, with the project's pinned Playwright —
# the same installer (and the same package list) dispatched runs used per run.
# One layer per part, so a pull downloads them in parallel instead of one 2.6 GB
# layer as a single stream; each layer leaves no apt lists or caches behind.
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" && rm -rf /root/.npm /tmp/*
RUN playwright install-deps chrome msedge firefox webkit && rm -rf /var/lib/apt/lists/* /tmp/*
RUN playwright install chrome && rm -rf /var/lib/apt/lists/* /tmp/*
RUN playwright install msedge && rm -rf /var/lib/apt/lists/* /tmp/*
RUN playwright install firefox webkit && rm -rf /tmp/*

# Build record: exact versions, read by the workflow's image check and uploaded with test results.
COPY record-versions.js /usr/local/lib/assurelayer/record-versions.js
RUN BUILD_DATE="${BUILD_DATE}" SOURCE_COMMIT="${SOURCE_COMMIT}" PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION}" \
    node /usr/local/lib/assurelayer/record-versions.js > /etc/assurelayer-runner-image.json \
 && cat /etc/assurelayer-runner-image.json

LABEL org.opencontainers.image.title="assurelayer-runner" \
      org.opencontainers.image.description="AssureLayer four-browser Playwright runner (Chrome, Edge, Firefox, WebKit)" \
      org.opencontainers.image.source="https://github.com/kojisongwriter-pixel/qa-automation-playwright" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"

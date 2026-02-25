FROM myoung34/github-runner:latest

# Install tools needed by deploy-stack.sh and tests
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install age
ARG AGE_VERSION=v1.2.1
RUN curl -fsSL "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-amd64.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/bin age/age age/age-keygen

# Install sops
ARG SOPS_VERSION=v3.9.4
RUN curl -fsSL "https://github.com/getsops/sops/releases/download/${SOPS_VERSION}/sops-${SOPS_VERSION}.linux.amd64" \
    -o /usr/local/bin/sops && chmod +x /usr/local/bin/sops

# Install bats
ARG BATS_VERSION=v1.11.0
RUN git clone --depth 1 --branch ${BATS_VERSION} https://github.com/bats-core/bats-core.git /tmp/bats \
    && /tmp/bats/install.sh /usr/local \
    && rm -rf /tmp/bats

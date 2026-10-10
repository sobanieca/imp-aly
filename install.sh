#!/bin/bash

set -e

REPO="sobanieca/imp-aly"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="imp-aly"

echo "Installing imp-aly..."

OS="$(uname -s)"
case "$OS" in
  Linux*) OS_TYPE="linux" ;;
  Darwin*) OS_TYPE="macos" ;;
  *)
    echo "Error: unsupported operating system: $OS (supported: Linux, macOS)"
    exit 1
    ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH_TYPE="x64" ;;
  aarch64|arm64) ARCH_TYPE="arm64" ;;
  *)
    echo "Error: unsupported architecture: $ARCH (supported: x86_64, arm64)"
    exit 1
    ;;
esac

ASSET="${BINARY_NAME}-${OS_TYPE}-${ARCH_TYPE}"
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Downloading ${URL}"
if command -v curl > /dev/null 2>&1; then
  curl -fsSL -o "${TMP_DIR}/${BINARY_NAME}" "${URL}"
  curl -fsSL -o "${TMP_DIR}/${ASSET}.sha256" "${URL}.sha256"
elif command -v wget > /dev/null 2>&1; then
  wget -q -O "${TMP_DIR}/${BINARY_NAME}" "${URL}"
  wget -q -O "${TMP_DIR}/${ASSET}.sha256" "${URL}.sha256"
else
  echo "Error: install curl or wget, then run this script again"
  exit 1
fi

EXPECTED="$(cut -d ' ' -f 1 < "${TMP_DIR}/${ASSET}.sha256")"

if [ -w "${INSTALL_DIR}" ]; then
  SUDO=""
else
  SUDO="sudo"
  echo "Note: sudo is needed to install to ${INSTALL_DIR}"
fi

checksum() {
  if command -v sha256sum > /dev/null 2>&1; then
    $SUDO sha256sum "$1" | cut -d ' ' -f 1
  else
    $SUDO shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

$SUDO mkdir -p "${INSTALL_DIR}"
STAGED="$($SUDO mktemp "${INSTALL_DIR}/.${BINARY_NAME}.install.XXXXXX")"
trap 'rm -rf "${TMP_DIR}"; $SUDO rm -f "${STAGED}"' EXIT
$SUDO cp "${TMP_DIR}/${BINARY_NAME}" "${STAGED}"

if [ "${EXPECTED}" != "$(checksum "${STAGED}")" ]; then
  echo "Error: the checksum of the download does not match"
  exit 1
fi

$SUDO chmod 755 "${STAGED}"
$SUDO mv -f "${STAGED}" "${INSTALL_DIR}/${BINARY_NAME}"

echo "Installed ${INSTALL_DIR}/${BINARY_NAME} $("${INSTALL_DIR}/${BINARY_NAME}" --version)"
echo "Run 'imp-aly help' to start."

#!/bin/bash

set -e

REPO="sobanieca/imp-aly"
DEFAULT_INSTALL_DIR="/usr/local/bin"
BINARY_NAME="imp-aly"
SCRIPT_URL="sobanieca.github.io/imp-aly/install.sh"

usage() {
  cat <<USAGE
Install imp-aly for Linux or macOS (x64, arm64).

Usage:
  curl -fsSL ${SCRIPT_URL} | bash

By default imp-aly is installed to ${DEFAULT_INSTALL_DIR}, for all users. If you
can't write to it, run the script with sudo:
  curl -fsSL ${SCRIPT_URL} | sudo bash

To install to a custom location, set INSTALL_DIR to a directory that is
on your PATH:
  curl -fsSL ${SCRIPT_URL} | INSTALL_DIR=~/.local/bin bash
USAGE
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *)
    echo "Error: unknown argument: $1"
    echo ""
    usage
    exit 1
    ;;
esac

if [ -n "${INSTALL_DIR:-}" ]; then
  CUSTOM_INSTALL_DIR=1
else
  CUSTOM_INSTALL_DIR=""
  INSTALL_DIR="${DEFAULT_INSTALL_DIR}"
fi

install_failed() {
  echo "Error: could not install imp-aly to ${INSTALL_DIR}"
  if [ -n "${CUSTOM_INSTALL_DIR}" ]; then
    echo "INSTALL_DIR must be a writable directory that is on your PATH, e.g.:"
    echo "  curl -fsSL ${SCRIPT_URL} | INSTALL_DIR=~/.local/bin bash"
  else
    echo "Most likely you need to run the script with sudo:"
    echo "  curl -fsSL ${SCRIPT_URL} | sudo bash"
    echo "or set INSTALL_DIR to a directory that is on your PATH, e.g.:"
    echo "  curl -fsSL ${SCRIPT_URL} | INSTALL_DIR=~/.local/bin bash"
  fi
  exit 1
}

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

mkdir -p "${INSTALL_DIR}" 2> /dev/null || install_failed
[ -w "${INSTALL_DIR}" ] || install_failed

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

checksum() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

STAGED="$(mktemp "${INSTALL_DIR}/.${BINARY_NAME}.install.XXXXXX")" || install_failed
trap 'rm -rf "${TMP_DIR}"; rm -f "${STAGED}"' EXIT
cp "${TMP_DIR}/${BINARY_NAME}" "${STAGED}" || install_failed

if [ "${EXPECTED}" != "$(checksum "${STAGED}")" ]; then
  echo "Error: the checksum of the download does not match"
  exit 1
fi

chmod 755 "${STAGED}"
mv -f "${STAGED}" "${INSTALL_DIR}/${BINARY_NAME}" || install_failed

echo "Installed ${INSTALL_DIR}/${BINARY_NAME} $("${INSTALL_DIR}/${BINARY_NAME}" --version)"
echo "Run 'imp-aly help' to start."

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "Warning: ${INSTALL_DIR} is not on your PATH"
    echo "Add it to your PATH, or set INSTALL_DIR to a directory that is on your PATH"
    ;;
esac

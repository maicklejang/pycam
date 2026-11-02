#!/bin/sh
# Create a self-signed certificate so phones allow camera access over HTTPS.
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout key.pem -out cert.pem -subj "/CN=camera-ai"

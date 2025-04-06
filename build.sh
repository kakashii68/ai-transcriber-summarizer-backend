#!/usr/bin/env bash

# Update and install yt-dlp and ffmpeg
apt-get update && \
apt-get install -y ffmpeg curl && \
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
chmod a+rx /usr/local/bin/yt-dlp

#!/usr/bin/env bash

# Create a local bin directory
mkdir -p bin

# Download yt-dlp binary
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
chmod +x bin/yt-dlp

# Download static ffmpeg
curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o bin/ffmpeg.tar.xz
tar -xf bin/ffmpeg.tar.xz -C bin --strip-components=1 --wildcards '*/ffmpeg'
chmod +x bin/ffmpeg/ffmpeg

echo "yt-dlp and ffmpeg downloaded to ./bin"
ls -l bin

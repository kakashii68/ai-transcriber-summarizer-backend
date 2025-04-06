#!/usr/bin/env bash

# Create a local bin directory
mkdir -p bin

# Download yt-dlp binary
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
chmod +x bin/yt-dlp

# Download static ffmpeg
curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o bin/ffmpeg.tar.xz
tar -xf bin/ffmpeg.tar.xz -C bin --strip-components=1 --wildcards '*/ffmpeg'
chmod +x bin/ffmpeg

echo "yt-dlp and ffmpeg downloaded to ./bin"
ls -l bin

echo "Installing Python and pip..."
sudo apt-get update
sudo apt-get install -y python3 python3-pip

echo "Installing Python dependencies from requirements.txt..."
pip install pytube

echo "Build process complete."

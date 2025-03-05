#!/bin/bash

# Define network name
NETWORK_NAME="proxy-network"

# Ensure the script is not running as root
if [ "$EUID" -eq 0 ]; then
    echo "This script should not be run as root! Please run it as your regular user."
    exit 1
fi

# Check if "-d" was passed as an argument
DETACHED_MODE=""

if [[ "$1" == "-d" ]]; then
    DETACHED_MODE="-d"
    echo "Running in detached mode..."
else
    echo "Running in foreground mode..."
fi

# Check if the network exists, if not, create it
if ! docker network ls | grep -q $NETWORK_NAME; then
    echo "Creating Docker network: $NETWORK_NAME..."
    docker network create --driver bridge --attachable $NETWORK_NAME
else
    echo "Docker network '$NETWORK_NAME' already exists."
fi

# Define service directories
SERVICES=("proxy" "gomezbot" "aaronkoenescom" "image-server")

# Start each service in parallel
for SERVICE in "${SERVICES[@]}"; do
    echo "Starting $SERVICE..."
    SERVICE_DIR="$HOME/local-docker-sites/$SERVICE"

    if [ ! -d "$SERVICE_DIR" ]; then
        echo "Error: Directory $SERVICE_DIR not found!"
        exit 1
    fi

    cd "$SERVICE_DIR" || exit

    # Run docker-compose up in the background for all services
    docker-compose up $DETACHED_MODE --build &

done

# Wait for all background processes to complete if not running in detached mode
if [[ -z "$DETACHED_MODE" ]]; then
    wait
fi

# Show running containers
echo "All containers are now running:"
docker ps
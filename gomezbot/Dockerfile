FROM node:18

# Set the working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm install

# Copy bot source code
COPY . .

# Start the bot
CMD ["node", "bot.js"]
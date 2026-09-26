
# Claude Scheduler

A browser extension for scheduling and automating prompts on Claude.ai.

Schedule messages, manage prompt queues, select AI models, and automate your workflow directly from your browser.

## Features

- ⏰ Schedule prompts for a specific date and time
- 📋 Manage multiple scheduled messages in a queue
- 🤖 Select Claude models and configure effort levels
- ⚡ Quick scheduling with customizable time presets
- 🔄 Automatic retries for failed requests
- 💬 Send prompts to existing or new conversations
- ⏳ Live countdown timers for scheduled tasks
- 💾 Persistent storage for scheduled prompts
- 🔔 Notifications and execution status tracking

## Installation

1. Download or clone this repository.
2. Open Brave and navigate to `brave://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `claude-scheduler` folder.

The extension is now ready to use.

## Usage

1. Open [Claude.ai](https://claude.ai) and sign in.
2. Click the Claude Scheduler extension icon.
3. Enter your prompt and select the desired execution time.
4. Optionally configure the AI model and effort level.
5. Click **Add to Queue**.

The extension will automatically execute your prompt at the scheduled time.

You can also edit, delete, or manually execute scheduled tasks.

## Configuration

Customize the extension through `settings.json`:

- Available AI models
- Effort levels
- Quick scheduling intervals
- Model menu labels

## Requirements

- Brave browser
- Active Claude.ai session
- Browser must remain open for scheduled execution

> Note: This extension interacts with the Claude.ai web interface. Changes to the website may affect its functionality.

## Tech Stack

JavaScript · Chrome Extension Manifest V3 · Chrome Storage API · Chrome Alarms API

## Disclaimer

This is an independent project and is not affiliated with or endorsed by Anthropic.

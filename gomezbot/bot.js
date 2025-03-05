import 'dotenv/config';
import express from 'express';
import {InteractionType} from 'discord-interactions';
import {VerifyDiscordRequest} from './utils.js';
import {EmbedBuilder, ActivityType} from 'discord.js';
import * as IDs from './discordIds.js';
import {addMoreButton, imagineButton, finishedButton, gomez_AddMoreModal} from './discordElements.js';
import Discord, {Events} from 'discord.js';
import fetch from 'node-fetch';
// import {Midjourney} from 'midjourney';
import https from "https";
import fs from "fs";
import {google} from "googleapis";
import moment from "moment";
import 'moment-timezone';


/*
 * Constants
 */

const app = express();
// The maximum amount of time we will wait for someone to hit 'Imagine'
// before we just remove the button. 300,000 ms = 5 minutes
const imagineTimeoutLengthMS = 300_000;
// How long the historicEvent data is cached before we should fetch it again
// 604,800,000 milliseconds = 1 week.
const historicEventTimeoutLengthMS = 604_800_000;
// Tracks how long to allow each message will have buttons before we just remove them all
const messageCleanupTimeouts = {};
// How long the lastEvent data is cached before we should fetch it again
const lastEventRetentionPeriodHours = 2;
// How long cached quote data is retained before we should fetch it again
const quoteRetentionPeriodHours = 24;
// Number of milliseconds in an hour
const millisecondsPerHour = 3_600_000;
// Number of milliseconds in an day
const millisecondsPerDay = 86_400_000;
// The number of milliseconds to retain cached lastEvent data before we should fetch it again
const lastEventRetentionPeriodMS
    = millisecondsPerHour * lastEventRetentionPeriodHours;
// The number of milliseconds to retain cached quote data before we should fetch it again
const quoteRetentionPeriodMS
    = millisecondsPerHour * quoteRetentionPeriodHours;
// The current time. Represented as the number of milliseconds since the epoch
const currentTimeMS = new Date().getTime();
// Basically indicates how far through the day we are. Will be a value between 0 and 86_400_000.
const millisecondOfDay = currentTimeMS % millisecondsPerDay;
const isBefore4am = millisecondOfDay < 14_400_000;
// Gets the millisecond time of the next instance of 4am that will occur
const next4am = new Date(new Date().setHours(isBefore4am ? 0 : 24,0,0,0) + 14_400_000);
// Gets how many milliseconds it will be until the next 4am.
const millisecondsTilNext4am = next4am - currentTimeMS;
// How long to let an quote's content be anything other than <blank>
const interactionCleanupDelay = 30_000;  // 30 seconds
// A zero-width space used to add newlines to quotes.
// eslint-disable-next-line no-irregular-whitespace
const zeroWidthSpace = `​`;
// Whether or not to use data from events that haven't started yet
const USE_FUTURE_EVENTS = false;
// Whether or not to save quote data to the Google Spreadsheet
const SAVE_TO_SPREADSHEET = true;
// Whether or not to generate a Midjourney image
const GENERATE_MIDJOURNEY_IMAGE = false;
// Whether or not to look up event data at all
const GET_ACTIVE_EVENT_DATA = true;
// Enable/disable functionality that integrations with Youtube
let ENABLE_YOUTUBE_INTEGRATION = true;
// An object to pass to fetch() to make successful requests to the discord API
const discordApiGETRequestHeaders = {
    method: 'GET',
    headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${process.env.GOMEZBOT_BOT_TOKEN}`,
    },
};
// Used when formatting dates to ensure that they display the correct time
const dateFormat = {
    timeZone: 'America/New_York',
}
const quoteTracker = [];
const defaultActivity = 'Waiting for quotes';
const monthNamesShort = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
];
const supportedImageExtensions = ['.png', '.jpg', '.jpeg', '.gif'];
let eventFetchTime = new Date().getTime() - 1;
const graphqlEndpoint = "https://gamersofmondayseve.xyz/graphql";
let nextReleaseTimeout = null;

/*
 * Variables
 */

let activeEvents = [];
let allQuotes = [];
let historicEvents = [];

/*
 * Discord Setup
 */

// Functions

/**
 *
 * @param data
 * @returns {string}
 */
const buildEventPageContent = data => {
    const {
        attendees = [],
    } = data;

    return `
    <h2>Attendees</h2>
    <ul id="attendees">  
      ${attendees.map(name => `<li>${name}</li>`).join("")}
    </ul>
    <h2>Games Played</h2>
    <ul></ul>
    <h2>Notes</h2>
    <p>&nbsp;</p>
    <h2>Media</h2>
      <div id="gomez_video_inliner">
        <!-- Put one or more Youtube iframes here to display them inline with one another -->  
        <!-- Recommended dimensions for iframes are width="460" height="270" -->
      </div>
    <h4>Highlights</h4>
    <p>&nbsp;</p>
    <style>  
      #gomez_video_inliner > * {   display: inline-block   }
    </style>
    <p>&nbsp;</p>
  `.replace(/(\n)|(\\n)/g, '');
};

/**
 * Empty's an interaction's content after a certain amount of time. This helps
 * prevent the content from being locked in permanently if, for example,
 * Midjourney just fails to create an image without telling us.
 *
 * @param interaction
 *
 */
const cleanInteraction = interaction => {
    const messageId = interaction.message.id;
    if (!messageId) {
        return;
    }
    if (messageCleanupTimeouts[messageId]) {
        console.log(`${logDate()}: Clearing Timeout`);
        clearTimeout(messageCleanupTimeouts[messageId]);
    }

    messageCleanupTimeouts[messageId] = setTimeout(async () => {
        await setActivity();
        interaction.channel.messages.fetch(messageId)
            .then(msg => {
                msg.edit({content: ''});
            });
    }, interactionCleanupDelay);
};

/**
 * Clears the current list of active events. The next time the list of events
 * is requested, it will be fetched and cached again. This function is
 * periodically invoked every _lastEventRetentionPeriodMS_ milliseconds
 */
const clearCache_ActiveEvents = () => {
    console.log(`${logDate()}: Clearing activeEvents`);
    activeEvents = [];
};

/**
 * Clears the current list of historic events. The next time the list of events
 * is requested, it will be fetched and cached again. This function is
 * periodically invoked every _historicEventTimeoutLengthMS_ milliseconds
 */
const clearCache_HistoricEventData = () => {
    console.log(`${logDate()}: Clearing out cached historic event data`);
    historicEvents = [];
};

/**
 * Clears the current list of quotes. The next time the quotes are requested,
 * they will be fetched and cached again. This function is periodically
 * invoked every day at 4am.
 */
const clearCache_Quotes = () => {
    console.log(`${logDate()}: Clearing cached quotes`);
    allQuotes = [];
};

async function postJournalEntryToCalendar(event) {
    try {
        const res = await calendar.events.insert({
            calendarId: process.env.GOOGLE_APIS_JOURNAL_CALENDAR_ID,
            requestBody: event,
        });
        console.log('✅ Event created: %s', res.data.htmlLink);
    } catch (err) {
        console.error('❌ Error creating event', err);
    }
}

/**
 *
 * @param {object} data
 * @param {string} data.title
 * @param {string[]} data.attendees
 *
 * @returns {Promise<number>}  The ID of the page that was created
 */
const createPage_gomezSite = data => {
    const {title} = data;
    const date = new Date();
    const dateString = `${date.getFullYear()}-${monthNamesShort[date.getMonth()]}-${date.getDate()}`;

    const query = `
    mutation (
      $content:String!
      $path:String!
      $description:String!
      $title:String!
    ){
      pages{
        create(
          content: $content
          path: $path
          description: $description
          editor: "code"
          isPublished: true
          isPrivate: false
          locale: "en"
          tags: []
          title: $title
        ){
          responseResult{
            succeeded
            message
            slug
            errorCode
          }
          page{
            id
          }
        }
      }
    }`;

    const content = buildEventPageContent(data);

    const requestBody = {
        query,
        variables: {
            content,
            path: `/Events/${title.replace(/\s/g, '_').replace(/[^a-zA-Z0-9_]/g, '')}`,
            description: dateString,
            title,
        }
    };

    console.log(`${logDate()}: Attempting to create page`);
    console.log(requestBody);

    return fetch(graphqlEndpoint,{
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: {
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Connection': 'keep-alive',
            'DNT': '1',
            'Origin': 'https://gamersofmondayseve.xyz',
            Authorization: `Bearer ${process.env.GOMEZ_XYZ_TOKEN_FULL}`,
        },
    })
        .then(res => res.text())
        .then(txt => {
            console.log(`${logDate()}: \tCreate Page Result:`, txt);
            return JSON.parse(txt);
        })
        .then(result => result.data.pages.create.page.id)
        .catch(errorDetails => {
            errorHandler({
                description: "Failed to create page on gomez.xyz",
                data: {
                    requestBody,
                },
                error: errorDetails
            });
            return {};
        })

};

const createJournalEntry = (journalText) => {
    const nowInEastern = moment().tz(dateFormat.timeZone);

// Format the date and time in the desired format
// This will automatically adjust for the Eastern Timezone offset, whether it's EST or EDT.
    const startTime = nowInEastern.format('YYYY-MM-DDTHH:mm:ssZ');
    const endTime = moment(startTime).add(1, 'minutes');

// Example usage
    const event = {
        summary: 'Journal Entry',
        // location: '800 Howard St., San Francisco, CA 94103',
        description: journalText,
        start: {
            dateTime: startTime,
            timeZone: dateFormat.timeZone,
        },
        end: {
            dateTime: endTime,
            timeZone: dateFormat.timeZone,
        },
    };
    console.log(`👑 Attempting to create test event`);

// Replace 'your_calendar_id' with the actual ID of the calendar you want to add an event to
    postJournalEntryToCalendar(event)
        .then(() => {
            console.log(`👑 Done attempting to create test event`);
        });
};

/**
 * Default functionality that runs when the discord client successfully logs
 * in upon bot startup.
 *
 * @returns {Promise<void>}
 */
const discordClientReadyHandler = async () => {
    console.log(`${logDate()}: Logged in as ${discordClient.user.tag}!`);
    await setActivity();
};

/**
 * Downloads a file and renames it, either with the given name or, if that is
 * missing, it's existing name plus a random string to help ensure uniqueness.
 *
 * @param url
 * @param assignedFilename
 * @returns {string}
 */
const downloadImage = (urlRaw, assignedFilename) => {
    const [url, params] = urlRaw.split('?');
    const urlSplit = url.split("/");
    const currentFilenameAndExt = urlSplit[urlSplit.length - 1];
    const ext = currentFilenameAndExt.split('.').pop();
    const currentFilename = currentFilenameAndExt.substring(0, currentFilenameAndExt.length - ext.length - 1);
    const storageFolder = `/media/images`;
    const downloadPath = `${storageFolder}/${currentFilenameAndExt}`;
    const randomChars = randChars(6);
    const randomFilename = `${currentFilename}-${randomChars}.${ext}`;
    const assignedFilenameExtension = assignedFilename?.split('.')[assignedFilename?.split('.').length - 1];

    if (!supportedImageExtensions.includes(`.${ext}`)) {
        console.log(`${logDate()}: Not downloading. Extension '${ext}' is not supported`);
        return;
    }

    // Always have the target filename's extension match that of the file being downloaded
    if (assignedFilename && assignedFilenameExtension !== ext) {
        assignedFilename = `${assignedFilename}.${ext}`;
    }

    const finalFilename = assignedFilename || randomFilename;
    const newFilePath = `${storageFolder}/${finalFilename}`;

    const finalURL = `https://quartekoen.ddns.net/GomezBot/images/${finalFilename}`;

    https.get(`${url}?${params}`, (res) => {
        const writeStream = fs.createWriteStream(downloadPath);

        res.pipe(writeStream);

        writeStream.on("finish", () => {
            writeStream.close();
            console.log(`${logDate()}: \tRenaming ${downloadPath}\n\t\tTo ${newFilePath}`);
            fs.rename(downloadPath, newFilePath, param => {
                console.log(`\tRenamed`);
            });
            console.log(`${logDate()}: \tDownload Completed!`);
        })
    });

    return finalURL;
};

/**
 * Logs error details to the script logs as well as to the bot-errors channel
 * on the test server.
 *
 * @param {Object} errorDetails
 * @param {Object} errorDetails.description - A description of the error
 * @param {Object} errorDetails.data - Data that was sent to the offending function
 * @param {Object} errorDetails.error - The error itself
 */
const errorHandler = errorDetails => {
    const {description, data, error} = errorDetails;
    console.log(`${logDate()}: Handling Error: ${description}\n`);
    console.log(`${logDate()}: \nRaw Error:\n******************************`);
    console.log(error);
    console.log(`${logDate()}: \nData being processed:\n******************************`);
    console.log(data);

    discordClient
        .channels
        .fetch(IDs.textChannelIds[IDs.serverIds.q_chat]["bot-errors"])
        .then(channel => {
            channel.send(`${description}\nError: ${error}\nData: ${JSON.stringify(data)}`);
        });
};

/**
 * Triggers when an event is started on blue_dooshes. Records the event to the
 * spreadsheet if spreadsheet saving is enabled.
 *
 * @param {Object} oldEventData
 * @param {Object} newEventData
 * @returns {Promise<void>}
 */
const eventStartHandler = async (oldEventData, newEventData) => {
    if (oldEventData.status === 1 && newEventData.status === 2) {

        const eventName = newEventData.name || 'Unnamed Event';
        const eventId = newEventData.id;

        // The event was started!
        saveToSpreadsheet: {
            let requestBody;

            if (!SAVE_TO_SPREADSHEET) {
                console.log(`${logDate()}: \tNot saving event to spreadsheet. Function is disabled.`);
                break saveToSpreadsheet;
            }

            console.log(`${logDate()}: \tSaving event to spreadsheet`);
            await setActivity('Immortalizing a event');
            const localeDate
                = new Date().toLocaleString('en-US', {timeZone: 'America/New_York'});
            const d = new Date(localeDate);
            const month = monthNamesShort[d.getMonth()];
            const dStr = `${d.getFullYear()}-${month}-${d.getDate()}`;
            const imageUrl = newEventData.image;
            let eventImageURL = newEventData.image
                ? `https://cdn.discordapp.com/guild-events/${
                    eventId}/${newEventData.image}.png?size=2048`
                : null;
            const hasImage = !!imageUrl;
            if (hasImage) {
                const eventName_filename = eventName
                    .replace(/\s/g, '_')
                    .replace(/[^a-zA-Z0-9_]/g, '')
                eventImageURL = downloadImage(eventImageURL, eventName_filename);
            }
            requestBody = {
                return_values: 'true',
                data: {
                    'ID': 'INCREMENT',
                    'Date': dStr,
                    'Name': eventName,
                    'Discord Event ID': newEventData.id,
                    'Image URL': hasImage
                        ? eventImageURL
                        : '',
                },
            };

            // Save the event to the Gomez Events Google Sheet
            // https://docs.google.com/spreadsheets/d/1-KAgCZAlLwxfcC3RlZBpxtu-e0NC1obnMWCcNzyNdK4/edit#gid=1537771689
            await fetch('https://sheetdb.io/api/v1/ttr3mw8gw8jza?sheet=Raw%20Game%20Night%20Data', {
                method: 'POST',
                body: JSON.stringify(requestBody),
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.SHEETDB_GOMEZ_EVENTS_TOKEN}`,
                },
            })
                .then(res => res.text())
                .then(async txt => {
                    // Check whether SheetDB.io had a gateway timeout error. If so,
                    // it will return HTML and the first character will be a <.
                    // Try again.
                    if (txt.substring(0,1) === "<") {
                        console.log(`${logDate()}: \tRetrying because SheetDB responded with the following HTML:\n*************************************`);
                        console.log(txt);
                        txt = await fetch('https://sheetdb.io/api/v1/ttr3mw8gw8jza?sheet=Raw%20Game%20Night%20Data', {
                            method: 'POST',
                            body: JSON.stringify(requestBody),
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: `Bearer ${process.env.SHEETDB_GOMEZ_EVENTS_TOKEN}`,
                            },
                        })
                            .then(res => res.text())
                            .then(txt => {
                                console.log(`${logDate()}: \tRetry Save Event to Spreadsheet Result:`, txt);

                                // Check whether SheetDB.io had a gateway timeout error. If so,
                                // it will return HTML and the first character will be a <.
                                if (txt.substring(0,1) === "<") {
                                    // We already tried again. Throw an error this time.
                                    throw "Unable to record event data. SheetDB.io gateway timeout. Please record event manually.";
                                }

                                return txt;
                            });
                    }

                    return txt;
                })
                .then(txt => {
                    console.log(`${logDate()}: \tSave Event to Spreadsheet Result:`, txt);
                    return JSON.parse(txt);
                })
                .catch(errorDetails => {
                    // Error Capture Complete
                    errorHandler({
                        description: "Failed to save event data to spreadsheet",
                        data: requestBody,
                        error: errorDetails
                    });
                })
                .finally(setActivity);
        }

        // Refresh the active event data
        activeEvents = await getActiveEventData(true);

        // Get the list of users currently in the event's channel
        const connectedUserNames = await discordClient
            .channels
            .fetch(IDs.voiceChannelIds[IDs.serverIds.blue_dooshes]["Gomez"])
            .then(channel => {
                return channel
                    .members
                    .filter(member => !member.user.bot)
                    .map(member => IDs.discordIdToName[member.user.id]);
            });

        const activeEvent = activeEvents.find(event => event.id === eventId);
        if (activeEvent) {
            activeEvent.attendees = connectedUserNames || [];
        } else {
            console.error(`Event with ID ${eventId} is started but isn't in list of active events!`);
            console.log(`${logDate()}: Active event data:${'*'.repeat(30)}\n`);
            console.log(activeEvents);
            errorHandler({
                description: "Event was started but no active event found.",
                data: {
                    connectedUserNames,
                    eventName,
                    eventId,
                    activeEvents,
                },
                error: ""
            });
        }

        await createPage_gomezSite({
            attendees: connectedUserNames,
            title: eventName,
        })
            .then(result => {
                console.log(`${logDate()}: Page Creation result: ${result}`);
                if (activeEvent) {
                    console.log(`${logDate()}: Setting page ID of ${result} on activeEvent`);
                    activeEvent.gomezPageId = result;
                }
                return {id: result};
            })
    }
};

/**
 * Gets all quotes from the spreadsheet and stores them in allQuotes.
 *
 * @returns {Promise<unknown>}
 */
const fetchAllQuotes = async () => {
    if (allQuotes.length > 0) {
        console.log(`${logDate()}: Returning ${allQuotes.length} cached quotes`);
        return allQuotes;
    }

    console.log(`${logDate()}: Fetching quotes`);
    return await fetch('https://sheetdb.io/api/v1/mj3l9zcupr35e/', {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.SHEETDB_GOMEZ_QUOTES_TOKEN}`,
        },
    })
        .then(res => res.text())
        .then(txt => {
            const spreadsheetData = JSON.parse(txt);
            if (!!spreadsheetData.error) {
                console.log(`${logDate()}: Error getting all quote data`, spreadsheetData.error);
                throw spreadsheetData.error;
            }
            spreadsheetData.forEach(quote => allQuotes.push(quote));
            console.log(`${logDate()}: Cached ${allQuotes.length} quotes`);
            return allQuotes;
        })
        .catch(async errorDetails => {
            // Error Capture Complete
            errorHandler({
                description: "Failed to get all quote data from spreadsheet",
                data: {},
                error: errorDetails
            });
        })
        .finally(setActivity);
};

/**
 * Retrieves all historice event data from the spreadsheet.
 *
 * @param forceFetch
 * @returns {Promise<unknown>}
 */
const fetchHistoricEventData = async (forceFetch = false) => {
    if (historicEvents.length > 0 && !forceFetch) {
        console.log(`${logDate()}: Returning ${historicEvents.length} cached events`);
        return historicEvents;
    }

    return await fetch('https://sheetdb.io/api/v1/ttr3mw8gw8jza/?sheet=Raw%20Game%20Night%20Data', {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.SHEETDB_GOMEZ_EVENTS_TOKEN}`,
        },
    })
        .then(res => res.text())
        .then(txt => {
            const spreadsheetData = JSON.parse(txt);
            if (!!spreadsheetData.error) {
                console.log(`${logDate()}: Error getting all event data`, spreadsheetData.error);
                throw spreadsheetData.error;
            }
            console.log(`${logDate()}: Cached ${spreadsheetData.length} events`);
            return spreadsheetData;
        })
        .catch(async errorDetails => {
            errorHandler({
                description: "Failed to get all event data from spreadsheet",
                data: {},
                error: errorDetails
            });
        })
        .finally(setActivity);
};

const fetchYoutubeVideoDetails = async (videoIds) => {
    if (!ENABLE_YOUTUBE_INTEGRATION) {
        console.log(`${logDate()}: Not fetching Youtube video details. Feature is disabled`);
        return [];
    }

    if (!videoIds || videoIds.length === 0) {
        console.log(`${logDate()}: Not fetching Youtube video details. No video IDs specified`);
        return [];
    }

    if (!YT_BEARER_TOKEN || !(await isGoogleAPIsAccessTokenValid())) {
        YT_BEARER_TOKEN = await getNewGoogleAPIsAccessToken();
    }

    if (!YT_BEARER_TOKEN) {
        console.log(`${logDate()}: Not fetching Youtube video details. Feature is enabled but we're missing the bearer token somehow.`);
        return [];
    }

    console.log(`${logDate()}: Fetching video details for ${videoIds.length} video Ids`);

    const videoDetails = []
    const myHeaders = new Headers();
    myHeaders.append("Authorization", `Bearer ${YT_BEARER_TOKEN}`);

    const requestOptions = {
        method: 'GET',
        headers: myHeaders,
        redirect: 'follow'
    };
    let requestsRemaining = 10;
    let videoIdSubset = videoIds.splice(0,50);

    while (videoIdSubset.length > 0 && --requestsRemaining > 0) {
        console.log(`${logDate()}: ${"*".repeat(20)}`);
        console.log(`${logDate()}: Fetching videoId subset...\n\t${videoIdSubset.join(",")}`);
        const apiURL = `https://youtube.googleapis.com/youtube/v3/videos?part=status&part=fileDetails&part=id&part=processingDetails&part=recordingDetails&part=snippet&id=${videoIdSubset.join(",")}`;
        await fetch(apiURL, requestOptions)
            .then(response => response.text())
            .then(response => JSON.parse(response))
            .then(results => {
                console.log(`${logDate()}: Got ${results.items?.length} video detail result(s)`);
                videoDetails.push(...results.items);
            });
    }

    return videoDetails;
};

/**
 * Gets all videos on the Gomez Youtube Channel
 * @returns {Promise<*[]>}
 */
const fetchYoutubeVideos = async () => {
    if (!ENABLE_YOUTUBE_INTEGRATION) {
        console.log(`${logDate()}: Not fetching Youtube video details. Feature is disabled`);
        return [];
    }

    console.log(`${logDate()}: 🔥️ Getting live Youtube video data`);

    if (!YT_BEARER_TOKEN || !(await isGoogleAPIsAccessTokenValid())) {
        YT_BEARER_TOKEN = await getNewGoogleAPIsAccessToken();
    }

    if (!YT_BEARER_TOKEN) {
        console.log(`${logDate()}: Not fetching Youtube videos. Feature is enabled but we're missing the bearer token somehow.`);
        return [];
    }

    const videos = []
    const maxVideoCount = 50;
    const myHeaders = new Headers();
    myHeaders.append("Authorization", `Bearer ${YT_BEARER_TOKEN}`);

    const requestOptions = {
        method: 'GET',
        headers: myHeaders,
        redirect: 'follow'
    };
    let nextPageToken = '';
    let requestsRemaining = 10;

    do {
        const myVideosURL = `https://youtube.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video&pageToken=${nextPageToken}&maxResults=${maxVideoCount}`;
        await fetch(myVideosURL, requestOptions)
            .then(response => response.text())
            .then(response => {
                // console.log(response);
                return JSON.parse(response);
            })
            .then(result => {
                if (result.error) {
                    throw result.error.message;
                }

                videos.push(...result.items);
                console.log(`${logDate()}: Got ${result.items?.length} videos for a total of ${videos.length}. Next page: ${result.nextPageToken}`);
                if ((result.items?.length || 0) === 0 ) {
                    console.log(result);
                }
                nextPageToken = result.nextPageToken;
            });
    } while (!!nextPageToken && --requestsRemaining > 0);

    return videos;
};

/**
 * Gets information on the any current active events and stores it in activeEvents.
 * Uses the event data store in historicEvents if it exist
 *
 * @param forceFetch
 * @returns {Promise<string|*[]>}
 */
const getActiveEventData = async (forceFetch = false) => {
    if (!GET_ACTIVE_EVENT_DATA) {
        console.log(`${logDate()}: Not fetching event data. Function is disabled.`);
        return [];
    }

    if (activeEvents.length > 0 && !forceFetch) {
        console.log(`${logDate()}: Returning cached event data`);
        return activeEvents;
    }

    if (!forceFetch && new Date().getTime() < eventFetchTime) {
        console.log(`${logDate()}: Next Event Lookup Time not reached. Returning cached event data`);
        return activeEvents;
    }

    const eventsURL
        = `https://discord.com/api/guilds/${IDs.serverIds.blue_dooshes}/scheduled-events`;

    console.log(`${logDate()}: Fetching fresh event data from discord...`);
    return await fetch(eventsURL, discordApiGETRequestHeaders)
        .then(res => res.text())
        .then(txt => {
            return JSON.parse(txt);
        })
        .then(eventData => {
            if (!USE_FUTURE_EVENTS) {
                eventData = ( eventData || [] ).filter(event => event.status === 2);
            }

            activeEvents = eventData;

            // Use cached data for the next 30 minutes
            eventFetchTime = new Date().getTime() + 1_800_000;

            return eventData;
        })
        .catch(async errorDetails => {
            clearCache_ActiveEvents();
            errorHandler({
                description: "Failed to get event data",
                data: {
                    eventsURL,
                },
                error: errorDetails
            });
        });
};

/**
 * Uses the refresh token to get an updated access token
 * @returns {Promise<null|*>}
 */
const getNewGoogleAPIsAccessToken = async () => {
    console.error(`☝️ Fetching new token`);

    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const payload = {
        grant_type: 'refresh_token',
        refresh_token: process.env.GOOGLE_APIS_REFRESH_TOKEN,
        client_id: process.env.GOOGLE_APIS_CLIENT_ID,
        client_secret: process.env.GOOGLE_APIS_CLIENT_SECRET,
    };

    try {
        const response = await fetch(tokenUrl,{
            method: 'POST',
            body: JSON.stringify(payload),
        })
            .then(res => res.text())

        return JSON.parse(response).access_token;
    } catch (error) {
        console.error('❌ Error refreshing access token:', error);
        return null;
    }
}

/**
 * Fires when a user joins any voice channel
 *
 * @param oldMember
 * @param newMember
 * @returns {Promise<void>}
 */
const guildMemberAddHandler = async (oldMember, newMember) => {
    const hasJoined = !oldMember.channelId && newMember.channelId;
    const memberId = newMember.id;
    const memberName = IDs.discordIdToName[memberId];

    if (!hasJoined) {
        // We don't care when people leave;
        console.log(`${logDate()}: ${memberName} left`);
        return;
    }

    console.log(`${logDate()}: ${memberName} joined`);
    console.log(newMember);

    // Check if there are any active events.

    // If there is an active event, record the user as having attended.
    // Note that we don't check that the user joined the event's voice
    // channel because it's more likely that someone will join just any
    // channel than it is that we'll have people in multiple voice channels
    // and that we only care about who joined the event's channel. Thus
    // record all voice joiners as attendees.
    if (activeEvents.length === 0) {
        console.log(`${logDate()}: No event in progress. Nothing to record`);
        activeEvents = await getActiveEventData();
        if (activeEvents.length === 0) {
            return;
        }
    }

    // If there are any active events, add the newly-joined user
    // to it. We assume for now that only one event will be going
    // on at a time and that user is joining it.
    if (!activeEvents[0].attendees.includes(memberName)) {
        activeEvents[0].attendees.push(memberName);

        await updatePage_gomezSite({
            id: activeEvents[0].gomezPageId,
            attendees: activeEvents[0].attendees
        }).then(result => {
            console.log(`${logDate()}: Done updating Event page with id ${activeEvents[0].gomezPageId}`);
            console.log(result);
        });
    }
};

/**
 * Responds to interactions from Discord, such as slash commands, button
 * presses and modal submissions.
 *
 * @param interaction
 * @returns {Promise<void>}
 */
const interactionHandler = async interaction => {
    const {
        commandName,
        user,
        customId,
    } = interaction;

    switch (interaction.type) {

        // Buttons
        case InteractionType.MESSAGE_COMPONENT:

            if (customId === 'add_more_to_quote') {
                await interaction.showModal(gomez_AddMoreModal);
            }
            if (customId === 'done_modifying_quote') {
                console.log(`${logDate()}: Attempting to complete quote`);

                // Record data about the quote. If we add an image to it later, the
                // data we record will allow the image URL to be saved to the
                // quote spreadsheet.
                quoteTracker[interaction.message.id]
                    = {timeRecorded: new Date().getTime()};

                // If the quote failed to save the spreadsheet earlier, the content will
                // contain an error. Clear that out before retrying.
                interaction.channel.messages.fetch(interaction.message.id)
                    .then(async msg => {
                        console.log(`${logDate()}: \tClearing current message content...`);
                        await msg.edit({content: ''});
                    });

                cleanInteraction(interaction);

                let imageUrl = interaction.message.embeds?.[0]?.image?.url;
                const hasImage = !!imageUrl;
                const timestamp = interaction.message.embeds?.[0]?.timestamp;
                const hasTimestamp = !!timestamp;
                // Preferably, we would use whatever event data was used on the quote itself, but it isn't possible
                // to store an arbitrary piece of data (like an event id) on an embed to retrieve later. The next
                // best thing is to assume that the quote will be completed during the same event that it was
                // spoken, and so looking up the current event data again will yield the same result.
                const activeEventData = await getActiveEventData();
                const activeEventId = activeEventData?.[0]?.id;
                let requestBody;
                let savedToSpreadsheet = false;

                /*
                 * 1. Save the quote to the Gomez Quotes spreadsheet
                 *    https://docs.google.com/spreadsheets/d/1-KAgCZAlLwxfcC3RlZBpxtu-e0NC1obnMWCcNzyNdK4/edit#gid=0
                 */
                saveToSpreadsheet: {

                    if (!SAVE_TO_SPREADSHEET) {
                        console.log(`${logDate()}: \tNot saving to spreadsheet. Function is disabled.`);
                        savedToSpreadsheet = true;
                        break saveToSpreadsheet;
                    }

                    console.log(`${logDate()}: \tSaving to spreadsheet...`);
                    await setActivity('Immortalizing a quote');
                    const d = hasTimestamp
                        ? new Date(new Date(timestamp).toLocaleString('en-US', {timeZone: 'America/New_York'}))
                        : new Date();
                    const month = monthNamesShort[d.getMonth()];
                    const dStr = `${d.getFullYear()}-${month}-${d.getDate()}`;

                    if (hasImage) {
                        imageUrl = downloadImage(imageUrl);
                        console.log(`${logDate()}: Downloaded image. URL is now\n\t${imageUrl}`);
                    }

                    const quoteWithNames = interaction.message.embeds[0].description.replace(/<@.*>/g, match => {
                        return IDs.discordIdToName[match.replace(/\D/g, '')] || 'Someone';
                    });
                    requestBody = {
                        return_values: 'true',
                        data: {
                            'ID': 'INCREMENT',
                            'Date': dStr,
                            'Discord Event ID': activeEventId,
                            'Recorded By': IDs.discordIdToName[interaction.user.id] ?? 'Someone',
                            'Quote': quoteWithNames,
                            'Message ID': interaction.message.id,
                            'Channel ID': interaction.channel.id,
                            'Image URL': hasImage
                                ? imageUrl
                                : '',
                        },
                    };

                    // Save the quote to the Gomez Quotes Google Sheet
                    // https://docs.google.com/spreadsheets/d/1-KAgCZAlLwxfcC3RlZBpxtu-e0NC1obnMWCcNzyNdK4/edit#gid=0
                    await fetch('https://sheetdb.io/api/v1/mj3l9zcupr35e/', {
                        method: 'POST',
                        body: JSON.stringify(requestBody),
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${
                                process.env.SHEETDB_GOMEZ_QUOTES_TOKEN}`,
                        },
                    })
                        .then(res => res.text())
                        .then(txt => {
                            console.log(`${logDate()}: \tSave Quote to Spreadsheet Result:`, txt);
                            const spreadsheetData = JSON.parse(txt);
                            if (!!spreadsheetData.error) {
                                throw spreadsheetData.error;
                            }
                            savedToSpreadsheet = true;
                            quoteTracker[interaction.message.id].spreadsheetRowId
                                = spreadsheetData.data[0].ID;
                            return spreadsheetData;
                        })
                        .catch(async errorDetails => {
                            // Error Capture Complete
                            errorHandler({
                                description: "Failed to save quote data to spreadsheet",
                                data: requestBody,
                                error: errorDetails
                            });
                            await interaction.update({
                                content: 'Quote couldn\'t be immortalized in the Google Sheet. '
                                    + 'Try again later.',
                            });
                            cleanInteraction(interaction);
                        })
                        .finally(setActivity);
                }

                /*
                 * 2. Remove the button controls for add/completing the quote
                 */
                if (savedToSpreadsheet) {
                    if (hasImage) {
                        console.log(`${logDate()}: \tQuote already has an image. Removing all controls.`);
                        await interaction.update({components: []});
                    } else if (!GENERATE_MIDJOURNEY_IMAGE) {
                        console.log(`${logDate()}: \tMidjourney is disabled. Removing all controls.`);
                        await interaction.update({components: []});
                    } else {
                        console.log(`${logDate()}: \tUpdating buttons to remove all but 'imagine'.`);
                        await interaction.update({
                            components: [
                                {
                                    type: 1,
                                    components: [imagineButton],
                                },
                            ],
                        });

                        console.log(`${logDate()}: \tScheduling all buttons to be removed in `
                            + `${imagineTimeoutLengthMS / 1000} seconds`);

                        setTimeout(() => {
                            interaction.channel.messages.fetch(interaction.message.id)
                                .then(msg => {
                                    msg.edit({components: []});
                                });
                        }, imagineTimeoutLengthMS);
                    }
                }
            }
            if (customId === 'gomez_imagine') {

                if (!GENERATE_MIDJOURNEY_IMAGE) {
                    console.log(`${logDate()}: Not generating image. Feature is disabled.`);
                    break;
                }

                // Dismiss the modal with reply()
                interaction.channel.messages.fetch(interaction.message.id)
                    .then(async msg => {

                        // show that it's imagining with the 🤔💭 emoji
                        const prompt_dirty = (msg.embeds[0].description || '')
                            .replace(/(<@.*>)/g, '')  // Remove usernames
                            .replace(/: /g, '') // Remove the colon and space after usernames
                            .replace(/\n/g, ', ')  // Replace newlines with commas
                            .replace(new RegExp(zeroWidthSpace, 'g'), '');
                        const prompt = prompt_dirty.substring(0, prompt_dirty.length - 2);

                        await setActivity(`Daydreaming about ${prompt}`);

                        console.log(`${logDate()}: Prompt:`, prompt);
                        const content = `🤔💭 Imagining ${prompt}`;
                        await msg.edit({
                            content,
                            components: [],
                        });
                        // const midjourneyClient = new Midjourney({
                        //   ServerId: IDs.serverIds.q_chat,
                        //   ChannelId: IDs.textChannelIds[IDs.serverIds.q_chat]["image-gen"],
                        //   SalaiToken: process.env.GOMEZBOT_DISCORD_ACCOUNT_TOKEN,
                        //   Debug: true,
                        //   Ws: true,
                        // });
                        // await midjourneyClient
                        //     .init()
                        //     .then(() => {
                        //       midjourneyClient.Imagine(prompt, async (uri, progress) => {
                        //         const content = `🤔💭 Imagining ${prompt} (${progress})`;
                        //         cleanInteraction(interaction);
                        //         await msg.edit({content});
                        //       })
                        //           .then(async Imagine => {
                        //             if (!Imagine) {
                        //               console.log(`${logDate()}: No imagination :(`);
                        //               return;
                        //             }
                        //             console.log(`${logDate()}: Imagination complete.`);
                        //             const U1CustomID = Imagine.options?.find(o => o.label === 'U1')?.custom;
                        //             if (!U1CustomID) {
                        //               console.log('no U1');
                        //               return;
                        //             }
                        //             console.log(`${logDate()}: Upscaling...`);
                        //             await setActivity("Dreaming Big");
                        //             const content = `🤔💭 Imagining ${prompt} (Upscaling...)`;
                        //             cleanInteraction(interaction);
                        //             await msg.edit({content});
                        //             await midjourneyClient.Custom({
                        //               msgId: Imagine.id,
                        //               flags: Imagine.flags,
                        //               customId: U1CustomID,
                        //               loading: (uri, progress) => {
                        //                 console.log(`${logDate()}: Upscaling progress: ${progress}`);
                        //               },
                        //             })
                        //                 .then(async result => {
                        //                   console.log(`${logDate()}: Upscaled URI:`, result.uri);
                        //                   const downloadedImageURL = downloadImage(result.uri);
                        //                   const currentEmbed = msg.embeds[0];
                        //                   const exampleEmbed = EmbedBuilder.from(currentEmbed);
                        //                   exampleEmbed.setImage(result.uri);
                        //                   console.log(`${logDate()}: Checking for quoteTracker data`);
                        //                   const rowId = quoteTracker[interaction.message.id]
                        //                       ?.spreadsheetRowId;
                        //                   if (rowId) {
                        //                     fetch(`https://sheetdb.io/api/v1/mj3l9zcupr35e/ID/${rowId}`, {
                        //                       method: 'PATCH',
                        //                       body: JSON.stringify({
                        //                         return_values: 'true',
                        //                         data: [{'Image URL': downloadedImageURL || result.uri}],
                        //                       }),
                        //                       headers: {
                        //                         'Content-Type': 'application/json',
                        //                         'Authorization': `Bearer ${
                        //                             process.env.SHEETDB_GOMEZ_QUOTES_TOKEN}`,
                        //                       },
                        //                     })
                        //                         .then(res => res.text())
                        //                         .then(txt => {
                        //                           console.log(`${logDate()}: Update Quote in Spreadsheet Result:`,
                        //                               txt);
                        //                         })
                        //                         .catch(async errorDetails => {
                        //                           // Error Capture Complete
                        //                           errorHandler({
                        //                             description: "Failed to update quote with image URL",
                        //                             data: {
                        //                               return_values: 'true',
                        //                               data: [{'Image URL': result.uri}],
                        //                             },
                        //                             error: errorDetails
                        //                           });
                        //                           await msg.edit({
                        //                             content: 'Quote Image couldn\'t be saved. '
                        //                                 + 'Try again later.',
                        //                           });
                        //                           cleanInteraction(interaction);
                        //                         });
                        //                   }
                        //
                        //                   await setActivity();
                        //                   // Add the image and remove the Imagine button
                        //                   await msg.edit({
                        //                     content: '',
                        //                     embeds: [exampleEmbed],
                        //                   });
                        //                   console.log(`${logDate()}: Upscale complete. Midjourney's work is done here. Disconnecting.`);
                        //                   midjourneyClient.Close();
                        //                 });
                        //           })
                        //           .catch(errorDetails => {
                        //             errorHandler({
                        //               description: "Failed during imagination",
                        //               data: {},
                        //               error: errorDetails
                        //             });
                        //
                        //             console.log(`${logDate()}: Imagination Error. Midjourney's work is done here. Disconnecting.`);
                        //             const isTermsError = errorDetails.includes("prompt is probably against our community standards");
                        //
                        //             if (isTermsError) {
                        //               const content = `🛑 Can't picture this. Midjourney believes it's against their community standards`;
                        //               cleanInteraction(interaction);
                        //               msg.edit({content});
                        //             }
                        //
                        //             midjourneyClient.Close();
                        //           });
                        //     })
                        //     .catch(errorDetails => {
                        //       errorHandler({
                        //         description: "Failed to initialize Midjourney",
                        //         data: {
                        //           prompt,
                        //           content,
                        //         },
                        //         error: errorDetails
                        //       });
                        //     });
                    });
            }

            break;

        // Slash commands
        case InteractionType.APPLICATION_COMMAND:

            if (!interaction.isChatInputCommand()) {
                break;
            }

            if (commandName === 'quote') {
                const quotedUser = await interaction.options.getUser('said_by').fetch();
                const quotedUserId = quotedUser.id;
                const quote = interaction.options.getString('dumb_thing_said');
                const quoteDate = interaction.options.getInteger('date');
                const attachment = interaction.options.getAttachment('image');
                const currentEvent = (await getActiveEventData())?.[0] || {};
                const {url} = !!attachment && attachment;

                // const embedContent = {
                //   quotedUserId,
                //   quote,
                //   imageUrl: url,
                //   quoterUser: user,
                // };

                const embedContent = {
                    accentColor: quotedUser.accentColor,
                    quoterUserId: user.id,
                    quote: `<@${quotedUserId}>: ${quote}`,
                    imageUrl: url,
                    eventData: {
                        name: currentEvent.name,
                        imageUrl: currentEvent.imageUrl,
                    }
                };
                if (quoteDate) {
                    embedContent.date = new Date(quoteDate);
                }
                const embed = await quoteEmbed(embedContent);

                // Add the buttons but don't add the "Remove Image" button
                // until an image is added
                const components = [
                    {
                        type: 1,
                        components: [addMoreButton, finishedButton],
                    },
                ];

                await interaction.reply({
                    fetchReply: true,
                    embeds: [embed],
                    components,
                });

                return;
            }

            if (commandName === 'onthisday') {
                const ephemeral = !interaction.options.getBoolean('share_with_channel');
                await onThisDay(interaction, ephemeral);

                await setActivity();
            }

            break;

        // Modal submissions
        case InteractionType.MODAL_SUBMIT:

            console.log(`${logDate()}: ${customId} modal submitted`);

            if (customId === 'gomez_add_more_to_quote') {

                const oldEmbedDescription = interaction.message.embeds[0].description;
                const newQuotedPerson
                    = interaction.fields.getTextInputValue('gomez_quote_saidby_1');
                const newQuotedPerson_lower = (newQuotedPerson || '').toLowerCase();
                const newQuotedPersonId = IDs.nameToDiscordId[newQuotedPerson_lower]
                    ? `<@${IDs.nameToDiscordId[newQuotedPerson_lower]}>`
                    : newQuotedPerson;
                const newEmbedDescription
                    = interaction.fields.getTextInputValue('gomez_quote_thingsaid_1');
                const newEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                    .setDescription(`${oldEmbedDescription}${newQuotedPersonId}: ${
                        newEmbedDescription}\n${zeroWidthSpace}`);

                interaction.update({embeds: [newEmbed]});

            }

            break;

        default:
            console.log(`${logDate()}: Unhandled interaction type: ${interaction.type}`);
            break;
    }
};

/**
 * Checks whether the current Google APIs access token is valid or not
 * @returns {Promise<boolean>}
 */
const isGoogleAPIsAccessTokenValid = async () => {
    if (!ENABLE_YOUTUBE_INTEGRATION) {
        console.log(`${logDate()}: Not checking token validity. Feature is disabled`);
        return false;
    }

    if (!YT_BEARER_TOKEN) {
        console.log(`${logDate()}: No token assigned`);
        return false;
    }

    return await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${YT_BEARER_TOKEN}`)
        .then(result => result.text())
        .then(result => {
            console.log(`${logDate()}: Introspection result:`);
            const isInvalid = JSON.parse(result).error === "invalid_token";
            if (isInvalid) {
                console.error(`\t❌\tCurrent token is invalid`);
            } else {
                console.error(`\t✅\tCurrent token is valid`);
            }
            return !isInvalid;
        })
};

const logDate = () => {
    const now = new Date();
    return `${monthNamesShort[now.getMonth()]}-${now.getDate()} ${now.getHours()%12}:${now.getMinutes()}:${now.getSeconds()} ${now.getHours >= 12 ? "pm" : "am"}`;
}

const msToHoursMins = milliseconds => {
    const hoursTil = Math.floor(milliseconds / 3_600_000);
    const minutesTil = Math.floor((milliseconds - (hoursTil * 3_600_000)) / 60_000)
    return `${hoursTil} hours, ${minutesTil} minutes`
};

/**
 * Locates quotes from within allQuotes which were created on this day
 * in other years and creates ephemeral replies in discord for each year.
 *
 * @param interaction
 * @param ephemeral
 * @returns {Promise<void>}
 */
const onThisDay = async (interaction, ephemeral = true) => {
    console.log(`\n${logDate()}: ***** Running OnThisDay *****`);
    await setActivity("Reminiscing...");

    await interaction.deferReply({ephemeral});
    const quotes = await fetchAllQuotes();
    const events = await fetchHistoricEventData();
    const quotesByYear = {};
    const videoIdsInQuotes = [];

    /*
     * Get Historic Quote Data
     */

    console.log(`${logDate()}: Unfiltered Quote Count: ${quotes.length}`);
    console.log(`${logDate()}: Looking for quotes with a date of ${new Date(new Date().toLocaleString('en-US', dateFormat)).getDate()}`);

    // Clean up the quote data
    const thisDateOtherYearQuotes = quotes
        .filter(entry => !!entry.Date) // Remove entries that are missing a date for some reason
        .map(entry => {
            entry.Date = new Date(entry.Date);
            return entry;
        }) // Convert date strings into Dates
        .filter(entry => entry.Date.toString() !== 'Invalid Date') // Remove entries with "" or undefined dates
        .filter(entry => entry.Date.getFullYear() !== 1969) // Remove entries with null dates
        .filter(entry => entry.Date.getFullYear() !== new Date().getFullYear()) // Remove entries from this year
        .filter(entry => entry.Date.getMonth() === new Date().getMonth()) // Retain entries from this month
        .filter(entry => entry.Date.getDate() === new Date(new Date().toLocaleString('en-US', dateFormat)).getDate()) // Retain entries from this date
        // .filter(quote => +quote.ID > 900) // Remove entries that are missing a date for some reason
        .map(quote => {

            if (quote["Video URL"]) {
                const quoteVideoId = quote["Video URL"].split("v=")[1];
                videoIdsInQuotes.push(quoteVideoId)
            }

            // Add event data to each quote if it exists
            const quoteEventId = quote['Discord Event ID'];
            if (!quoteEventId) {
                return quote;
            }

            const eventData = events.find(event => event['Discord Event ID'] === quoteEventId);
            if (!eventData) {
                console.log(`${logDate()}: ${quote.ID} - Has event ID ${quoteEventId} on quote but no event found with that ID.`);
                return quote;
            }

            quote.eventData = eventData;
            return quote;
        });

    /*
     * Get historic video data
     */

    console.log(`${logDate()}: Looking through ${youtubeVideos.length} videos for this date in history`);
    const pastVideoData = youtubeVideos
        .filter((video, index) => {
            const hasRecordingDate = !!video.recordingDetails?.recordingDate;
            const isReleased = video.status?.privacyStatus === "public";
            if (!hasRecordingDate) {
                return false;
            }

            if (!isReleased) {
                return false;
            }

            if( videoIdsInQuotes.indexOf(video.id.videoId) >= 0) {
                return false;
            }

            // Youtube gave us back the recording date, but in GMT, which equates to 7pm the previous day.
            // Add 5 hours to make it the right day.
            const fiveHoursInMS = 18_000_000;
            const recordingDate = new Date(new Date(video.recordingDetails.recordingDate).getTime() + fiveHoursInMS);

            const wasRecordedOnThisDay = recordingDate.getDate() === new Date().getDate()
                && recordingDate.getMonth() === new Date().getMonth()
                && recordingDate.getFullYear() !== new Date().getFullYear();

            if (!wasRecordedOnThisDay) {
                return false;
            }

            console.log(`${logDate()}: ${index}: ✅\t${video.id.videoId} - ${video.snippet.title} was recorded on this day in the past!`);

            return wasRecordedOnThisDay;
        })
        .map(pastVideo => {
            const year = new Date(pastVideo.recordingDetails?.recordingDate).getFullYear();
            const videoId = pastVideo.id.videoId;
            const title = pastVideo.snippet.title;
            const url = `https://www.youtube.com/watch?v=${videoId}`;
            console.log(`${logDate()}: Found historic video. ${title} (${videoId}) from ${year}`);

            return `${year}: [${title}](${url})`;
        });

    /*
     * Start outputting responses to the OnThisDay request
     */

    // No quotes or videos. Exit with a sad message.
    if (thisDateOtherYearQuotes.length === 0 && pastVideoData.length === 0) {
        interaction.editReply({
            content: `What a boring day in history. No quotes or videos found on ${
                monthNamesShort[new Date().getMonth()]} ${new Date().getDate()}.`,
            ephemeral: true,  // No quotes = don't bother people. Always ephemeral.
        });
        return;
    }

    // There are videos. Post them in a message.
    if (pastVideoData.length) {
        const messageContent = {
            content: `Videos from this day in history:\n\n${pastVideoData.join("\n")}`,
            ephemeral,
        };
        await interaction.editReply(messageContent);
    } else {
        console.log(`${logDate()}: No videos on this date.`);
    }

    // There are quotes. Post them in a message.
    if (thisDateOtherYearQuotes.length) {
        // Split the quotes by year
        thisDateOtherYearQuotes.forEach(quote => {
            const quoteYear = new Date(quote.Date).getFullYear();
            quotesByYear[quoteYear] ??= [];
            quotesByYear[quoteYear].push(quote);
        });

        // Sort the years ascending
        const years = Object.keys(quotesByYear).sort((a, b) => +a < +b);

        // Generate and output one post with up to 10 embeds for each year.
        for (const year of years) {
            const quotesForThisYear =
                quotesByYear[year].filter((entry, index) => index < 10)  // Discord limits to 10 embeds per post;
            const embedPromises = quotesForThisYear.map(async entry => {
                let accentColor;
                const usernameMatches = entry.Quote.match(
                    new RegExp(Object.keys(IDs.nameToDiscordId).join(":|") + ":", "ig"),
                    match => `<@${IDs.nameToDiscordId[match.replace(/:/g, '').toLowerCase()]}>:`
                );
                if (usernameMatches) {
                    const firstUsername = usernameMatches[0];
                    const usernameClean = firstUsername.replace(/:/g, '');
                    const userId = IDs.nameToDiscordId[usernameClean.toLowerCase()];
                    if (userId) {
                        await discordClient
                            .users
                            .fetch(userId, {force: true})
                            .then(user => {
                                accentColor = user.accentColor;
                            }).catch(errorDetails => {
                                errorHandler({
                                    description: "Failed to get quoter User data",
                                    data: {},
                                    error: errorDetails
                                });
                                return {};
                            });
                    }
                }
                return quoteEmbed({
                    quoterUserId: IDs.nameToDiscordId[entry["Recorded By"].toLowerCase()],
                    quoterUserName: entry["Recorded By"],
                    quote: entry.Quote,
                    accentColor,
                    date: "none",
                    imageUrl: entry["Image URL"],
                    videoUrl: entry["Video URL"],
                    eventData: {
                        name: entry.eventData?.Name,
                        imageUrl: entry.eventData?.["Image URL"],
                        gomezUrl: entry.eventData?.["Gomez.xyz link"],
                    },
                });
            });

            await Promise.all(embedPromises).then(async embeds => {
                const messageContent = {
                    content: `# ${year}`,
                    embeds,
                    ephemeral,
                };
                if (!interaction.replied) {
                    await interaction.editReply(messageContent);
                } else {
                    await interaction.followUp(messageContent);
                }
            });
        }
    } else {
        console.log(`${logDate()}: No quotes on this date.`);
    }
};

/**
 * Creates an embed for a quote.
 *
 * @param {Object} quoteData
 * @param {number} quoteData.accentColor - An integer representation of a hex color code. If unspecified,
 *    the value 7631988 (a light grey) will be used.
 * @param {number} quoteData.quoterUserId - The Discord ID of the person recording the quote
 * @param {string} quoteData.quote - The quote
 * @param {string} quoteData.imageUrl - A URL for an image to attach to the quote
 * @param {Date|string} quoteData.date - The date of the quote. If unspecified, the current
 *    date and time will be used. If "none" then no timestamp will be used.
 * @param {Object} quoteData.eventData
 * @param {string} quoteData.eventData.name
 * @param {string} quoteData.eventData.imageUrl
 * @returns {Promise<EmbedBuilder>}
 */
const quoteEmbed = async quoteData => {

    const {
        accentColor = 7631988,
        quoterUserName,
        quoterUserId,
        quote,
        imageUrl,
        date = new Date(),
        videoUrl,
        eventData = {},
    } = quoteData;

    const quoterUserData = quoterUserId ? await discordClient
        .users
        .fetch(quoterUserId)
        .then(user => {
            return user;
        }).catch(errorDetails => {
            errorHandler({
                description: "Failed to get quoter User data",
                data: {
                    quoteData,
                },
                error: errorDetails
            });
            return {};
        }) : {
        username: quoterUserName
    };

    const eventName = eventData?.name;
    const eventImageURL = eventData?.imageUrl;
    const quoterAvatarUrl = quoterUserData.avatar
        ? `https://cdn.discordapp.com/avatars/${quoterUserData.id}/${quoterUserData.avatar}.png?size=256`
        : null;

    const quoteWithLinkedUsers = quote
        .replace(
            new RegExp(Object.keys(IDs.nameToDiscordId).join(":|") + ":", "ig"),
            match => `<@${IDs.nameToDiscordId[match.replace(/:/g, '').toLowerCase()]}>:`
        );

    console.log("quoterUserData", {
        quoterUserData,
        quoterAvatarUrl,
    })

    const embed = new EmbedBuilder()
        .setColor(accentColor)
        .setDescription(`${eventName
            ? `${zeroWidthSpace}\n`
            : ''}${quoteWithLinkedUsers}\n${zeroWidthSpace}`)
        .setFooter({
            text: quoterUserData.username || '',
            iconURL: quoterAvatarUrl,
        });

    if (date !== "none") {
        embed.setTimestamp(date);
    }
    if (imageUrl) {
        embed.setImage(imageUrl);
    }
    if (eventName) {
        embed.setTitle(eventName);
    }
    // if (eventData.gomezUrl) {
    //   console.log(`Setting URL to ${eventData.gomezUrl}`);
    //   embed.setURL(eventData.gomezUrl);
    // }
    if (eventImageURL) {
        embed.setThumbnail(eventImageURL);
    }
    const fields = [];
    if (videoUrl) {
        fields.push(
            { name: 'Video', value: `[View Video Proof](${videoUrl})`, inline: true },
        )
    }
    if (eventData.gomezUrl) {
        fields.push({ name: 'Gomez.xyz', value: `[Event Page](${eventData.gomezUrl})`, inline: true })
    }
    if (fields.length) {
        embed.addFields(...fields);
    }

    return embed;
};

/**
 * Returns a string of random alphanumeric characters. Characters include
 *    a-z, A-Z, 0-9, _ and -. Default length is 12 characters.
 *
 * @param len
 * @returns {string}
 */
const randChars = (len = 12) => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
    let result = '';
    for (let i = 0; i < len; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
};

/**
 *
 * @param {number} id
 * @returns {Promise<string>}
 */
const renderPage_gomezSize = ({id}) => {
    const query = `
    mutation($id:Int!) {
      pages{
        render(
          id:$id
        ){
          responseResult{
            succeeded
            errorCode
            slug
            message
          }
        }
      }
    }`;

    const requestBody = {
        query,
        variables: {
            id,
        }
    };

    console.log(`${logDate()}: Attempting to render page with id ${id}`);
    console.log(requestBody);

    return fetch(graphqlEndpoint,{
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: {
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Connection': 'keep-alive',
            'DNT': '1',
            'Origin': 'https://gamersofmondayseve.xyz',
            Authorization: `Bearer ${process.env.GOMEZ_XYZ_TOKEN_FULL}`,
        },
    })
        .then(res => res.text())
        .then(txt => {
            console.log(`${logDate()}: \tRender Page Result:`, txt);
            return txt;
        })
};

/**
 * Schedules a timeout that will take action when a new video is released.
 */
const scheduleReleaseTimeout = () => {
    if (nextReleaseTimeout) {
        clearTimeout(nextReleaseTimeout);
    }

    // Exit if there are no videos to process
    const pendingRelease = youtubeVideos
        .filter(video => {
            return video.status?.privacyStatus === "private"
                && !!video.status?.publishAt
                && new Date(video.status.publishAt) > new Date();
        })
        .sort((a,b) => new Date(a.status.publishAt) - new Date(b.status.publishAt));

    if (pendingRelease.length > 0) {
        const nextRelease = pendingRelease[0];
        const nextReleaseDate = new Date(nextRelease.status.publishAt);
        let timeTilNextReleaseMS = nextReleaseDate.getTime() - new Date().getTime() + 120_000;

        console.log(`${logDate()}: Next Release Details:\n${"*".repeat(20)}`);
        console.log(`${logDate()}: \tName: ${nextRelease.snippet.title}`);
        console.log(`${logDate()}: \tPublish Date: ${nextReleaseDate.toLocaleString('en-US', dateFormat)}`);
        console.log(`${logDate()}: \tTime To Release: ${msToHoursMins(timeTilNextReleaseMS)}`);

        nextReleaseTimeout = setTimeout(() => {
            processVideoRelease(nextRelease)
        }, timeTilNextReleaseMS);
    }
};

/**
 * Handles the actions that must take place when a new video is released.
 *
 * @param videoData
 */
const processVideoRelease = videoData => {
    if (!videoData) {
        // We did something wrong and didn't send a video Id
        console.error("Can't process video release. No video Id was specified");
        return;
    }

    console.log(`${logDate()}: Processing potential video release: (${videoData.id.videoId}) ${videoData.snippet.title}`)

    // Get data about the specific release
    fetchYoutubeVideoDetails([videoData.id.videoId])
        // Verify that it is truly released
        .then(async updatedVideoArray => {
            const updatedVideoData = updatedVideoArray[0];
            console.log(`${logDate()}: Confirming video with ID ${updatedVideoData.id} is released`);
            const isReleased = updatedVideoData.status?.privacyStatus === "public";
            if (!isReleased) {
                // Our data was wrong. Update all video data and prepare the next release notification
                console.log(`${logDate()}: Video release shows video is not yet released. Re-fetching all video data and determining next release`);
                await updateAllVideoData();
            } else {
                // Update our internal video data to mark it as released
                youtubeVideos.find(video => video.id.videoId === videoData.id.videoId)
                    .status.privacyStatus = "public";
                // (optional) Send a Discord notification
                discordClient
                    .channels
                    .fetch(IDs.textChannelIds[IDs.serverIds.blue_dooshes]["new-releases"])
                    .then(channel => {
                        channel.send(`A new video has been released. [${videoData.snippet.title}](https://www.youtube.com/watch?v=${videoData.id.videoId})`);
                    });
            }
        })
        //    Schedule the next release
        .then(scheduleReleaseTimeout)


};

/**
 * Sets GomezBot's current activity display in Discord.
 *
 * @param activity
 * @returns {Promise<void>}
 */
const setActivity = async (activity = defaultActivity) => {
    console.log(`Attempting to set activity to '${activity}'`);
    await discordClient.user.setPresence({
        activities: [
            {
                name: activity,
                type: ActivityType.Custom,
            },
        ],
    })
};

const updateAllVideoData = async () => {
    console.log(`${logDate()}: Updating all video data`);
    const path = `/media/files/youtubeVideoDataAndDetails.txt`;

    await fetchYoutubeVideos()
        .then(async videoData => {
            console.log(`${logDate()}: \tProcessing data on ${videoData.length} videos`);
            const videoDetails = await fetchYoutubeVideoDetails(videoData.map(video => video.id.videoId));

            videoDetails.forEach(videoDetail => {
                const video = videoData.find(video => video.id.videoId === videoDetail.id);
                video.status = videoDetail.status;
                video.recordingDetails = videoDetail.recordingDetails;
                video.processingDetails = videoDetail.processingDetails;
            });
            return videoData;
        })
        .then(async videoData => {
            youtubeVideos = videoData;
            console.log(`${logDate()}: ✅\tGot video data from youtube. Writing to ${path}.`);
            try {
                fs.writeFileSync(path, JSON.stringify(youtubeVideos), 'utf8');
                console.log(`${logDate()}: ✅\tFile has been written/overwritten successfully.`);
            } catch (err) {
                console.error("❌ An error occurred while writing the file.", path, err);
            }
        })
        .catch(error => {
            console.log(`${logDate()}: ❌\tError getting Youtube video data`, error);
            console.log(`${logDate()}: ➡️\tFalling back on txt file ${path}`);
            try {
                const data = fs.readFileSync(path, 'utf8');
                youtubeVideos = JSON.parse(data);
                console.log(`${logDate()}: ✅\tSuccessfully loaded video data from file`);
                // You can now work with your JSON data
            } catch (err) {
                console.error(`${logDate()}: ❌\tError reading or parsing the file:`, path, err);
            }
        })
        .finally(() => {
            console.log(`${logDate()}: Done updating all video data`);
        });
};

/**
 *
 * @param id
 * @param attendees
 * @returns {Promise<string>}
 */
const updatePage_gomezSite = ({id, attendees = []}) => {
    const query = `
    mutation (
      $id:Int!
      $content:String!
    ){
      pages{
        update(
          id: $id
          content: $content
          isPublished: true
          isPrivate: false
        ){
          page{
        id
        content
      }
      responseResult{
        succeeded
        errorCode
        slug
        message
      }
        }
      }
    }`;

    const content = buildEventPageContent({attendees});

    const requestBody = {
        query,
        variables: {
            id,
            content,
        }
    };

    console.log(`${logDate()}: Attempting to update page`);
    console.log(requestBody);

    return fetch(graphqlEndpoint,{
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: {
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Connection': 'keep-alive',
            'DNT': '1',
            'Origin': 'https://gamersofmondayseve.xyz',
            Authorization: `Bearer ${process.env.GOMEZ_XYZ_TOKEN_FULL}`,
        },
    })
        .then(res => res.text())
        .then(txt => {
            console.log(`${logDate()}: \tUpdate Page Result:`, txt);
            return {id};
        })
        .then(renderPage_gomezSize)  // Assuming perfect success
        .then(() => {
            console.log(`${logDate()}: Update/render complete`);
        })
};

const writeToFile = async (filename, contents) => {
    if (typeof contents !== "string"){
        contents = JSON.stringify(contents);
    }

    console.log(`${logDate()}: Attempting to write to file ${filename}.txt`);
    const path = `/media/files/${filename}.txt`;

    await fs.open(path, 'a', async (err, fd) => {
        if(err) {
            console.log(`${logDate()}: Cant open file`);
            console.log(err);
        }else {
            await fs.write(fd, contents, (err) => {
                if (err) {
                    console.log(err);
                } else {
                    console.log(`${logDate()}: File written successfully.`);
                }
            });
        }
    });

}
// Client

const discordClient = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.GuildVoiceStates,
        Discord.GatewayIntentBits.GuildScheduledEvents,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.GuildMessageReactions,
    ],
});
discordClient.on('ready', discordClientReadyHandler);
discordClient.on(Events.GuildScheduledEventUpdate, eventStartHandler);
discordClient.on(Discord.Events.VoiceStateUpdate, guildMemberAddHandler);
discordClient.login(process.env.GOMEZBOT_BOT_TOKEN).then(() => {
    console.log(`${logDate()}: ✅\tDiscord Login Successful`);
});
discordClient.on(Discord.Events.InteractionCreate, interactionHandler);


// Get the youtube video data on initial startup
let youtubeVideos;
let YT_BEARER_TOKEN = await getNewGoogleAPIsAccessToken();
if (YT_BEARER_TOKEN) {
    ENABLE_YOUTUBE_INTEGRATION = true;
    console.log(`${logDate()}: Set bearer token to ${YT_BEARER_TOKEN.substring(0,5)}...`)
} else {
    ENABLE_YOUTUBE_INTEGRATION = false;
}
await updateAllVideoData()
    .then(scheduleReleaseTimeout);

// Google Calendar Integratoin
const KEYFILEPATH = './google-calendar-key.json';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: SCOPES,
});
const calendar = google.calendar({version: 'v3', auth});

/**
 * All events are cached in activeEvents when event data is fetched to prevent
 * event data from being requested so often that we get rate limited.
 * Clear the event data every so often to ensure that fresh data is available.
 */
setInterval(clearCache_ActiveEvents, lastEventRetentionPeriodMS);

/**
 * All quotes are cached when looked up by getAllQuotes. Quotes created after that point
 * won't be added to the cache, but that's okay at the moment because the only reason
 * that we look up all quotes at the moment is for On This Day functionality, which
 * only needs to be reset once a day anyway.
 *
 * Upon server startup, schedule the interval to start running at the next 4am. It will
 * then run once per day at 4am
 */
setTimeout(() => {
    clearCache_Quotes();
    updateAllVideoData();

    setInterval(clearCache_Quotes, quoteRetentionPeriodMS);
    setInterval(updateAllVideoData, millisecondsPerDay);
}, millisecondsTilNext4am);
console.log(`${logDate()}: 4am tasks will run in ${msToHoursMins(millisecondsTilNext4am)}.`)

/**
 * Periodically clear out the cache of historic events so that fresh data can be retrieved.
 * Historic event data is used for things like On This Day quoting, which only cares about
 * values from previous years, so a weekly clearing of this cache should be more
 * than sufficient.
 */
setInterval(clearCache_HistoricEventData, historicEventTimeoutLengthMS);


// app.use(express.json({verify: VerifyDiscordRequest(process.env.PUBLIC_KEY)}));
app.use(express.json());

app.get('/GomezBot/images/:filename', (req, res) => {
    const filename = req.params.filename;
    // Disallow slashes in filename
    const filenameNoSlashes = filename.replace(/\//g, '');
    // Only serve requests that end with these extensions
    const fileExtension = filenameNoSlashes.match(/\.\w*$/g)[0];
    const fileExists = fs.existsSync(`/media/images/${filenameNoSlashes}`);

    /*
     * Validation
     */

    if (!supportedImageExtensions.includes(fileExtension)) {
        console.log(`${logDate()}: Unsupported extension '${fileExtension}'`);
        res.status(404).send();
        return;
    }

    if (!fileExists) {
        console.log(`${logDate()}: Doesn't exist`);
        res.status(404).send();
        return;
    }

    // Serve the file
    res.sendFile(filenameNoSlashes, {root: '/media/images/'});
});

app.post('/Journal_Submit_Entry_3fc96osiaugamc3fifhhg153', (req, res) => {
    // Access the body of the POST request
    const requestBody = req.body;
    console.log('Received data:', requestBody);

    createJournalEntry(requestBody.journalText);

    res.status(200).send(JSON.stringify({response: "Data received and processed"}));
});

app.get("/Journal_Ping_g7a5sxh248y9n7hj1bw20dix", (req, res) => {
    console.log("Got journal server ping. Responding 200");
    res.status(200).send();
});

app.get("*", (req, res) => {
    res.status(404).send();
});

app.listen(3000, () => {
    console.log(`${logDate()}: App listening on port 3000`);
});

/*
 * Shutdown
 */

const signalHandler = async signal => {
    // do some stuff here
    console.log(`${logDate()}: Got ${signal}, Setting Gomez to Offline`);
    await setActivity('Offline');
    process.exit();
};
process.on('SIGINT', signalHandler);
process.on('SIGTERM', signalHandler);
process.on('SIGQUIT', signalHandler);
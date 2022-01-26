import axios from "axios";
import WebSocket from "ws";
import pkg from "winston";
import { DateTime } from "luxon";
const { createLogger, format, transports } = pkg;

const logger = createLogger({
    level: "info",
    format: format.combine(
        format.timestamp({
            format: "YYYY-MM-DD HH:mm:ss",
        }),
        format.splat(),
        format.json()
    ),
    defaultMeta: { service: "liquidator" },
    transports: [new transports.File({ filename: "liquidation.log" })],
});

function liquidation_event(evt) {
    const attrs = evt.attributes;
    for (const attr of attrs) {
        if (attr.key == "action" && attr.value == "liquidate_collateral") {
            return true;
        }
    }
    return false;
}

function get_timestamp(ts) {
    const dd = new Date(ts);
    const dt = DateTime.fromJSDate(dd).setZone("America/New_York");
    return dt.toFormat("yyyy-MM-dd HH:mm:ss.u");
}

const slackToken = "";
async function sendSlackMessage(data) {
    const msg = "⚠️  New Liquidation! \n" + JSON.stringify(data, null, 4);
    const url = "https://slack.com/api/chat.postMessage";
    const res = await axios.post(
        url, {
            channel: "#liquidation-log",
            text: msg,
        }, { headers: { authorization: `Bearer ${slackToken}` } }
    );
}

function get_link(txhash) {
    return `https://finder.extraterrestrial.money/mainnet/tx/${txhash}`;
}

async function handle_message(message) {
    var result = {};
    result.blocknum = message.data.block.header.height;
    result.timestamp = get_timestamp(message.data.block.header.time);

    const txs = message.data.txs;
    for (const [idx, txn] of txs.entries()) {
        result.txhash = get_link(txn.txhash);
        result.idx = idx;

        for (const log of txn.logs) {
            for (const evt of log.events) {
                if (!liquidation_event(evt)) {
                    continue;
                }

                const attrs = evt.attributes;
                for (const attr of attrs) {
                    switch (attr.key) {
                        case "liquidator":
                            result.liquidator = attr.value;
                            break;
                        case "borrower":
                            result.borrower = attr.value;
                            break;
                        case "repay_amount":
                            result.repay_amount = parseInt(attr.value) / 10 ** 6;
                            break;
                    }
                }

                if (result.repay_amount > 100) {
                    await sendSlackMessage(result);
                    logger.info(result);
                }
            }
        }
    }
}

function main() {
    var ws = new WebSocket("wss://observer.terra.dev");

    ws.onopen = function() {
        logger.warn("connected to websocket. subscribing...");
        ws.send(JSON.stringify({ subscribe: "new_block", chain_id: "columbus-5" }));
    };

    ws.onmessage = async function(data) {
        const message = JSON.parse(data.data);
        await handle_message(message);
    };

    ws.onclose = function() {
        logger.warn("websocket closed. reopening...");
        setTimeout(function() {
            main();
        }, 1000);
    };
}

main();

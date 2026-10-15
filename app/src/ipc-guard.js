'use strict';
// Un mensaje IPC solo es de confianza si viene del marco principal de nuestra propia página.
function isTrustedSender(event, appPageUrl) {
  const frame = event && event.senderFrame;
  return !!frame && !!event.sender && frame === event.sender.mainFrame && frame.url === appPageUrl;
}

module.exports = { isTrustedSender };

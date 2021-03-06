/* global document */
// @flow
import sdpParser from 'sdp-transform';

import SIP from '../../sip';
import type CallSession from '../../domain/CallSession';
import getApiClient from '../../service/getApiClient';
import Emitter from '../../utils/Emitter';
import Wazo from '../index';
import Participant from './Participant';

const TYPE_CHAT = 'chat';
const TYPE_SIGNAL = 'signal';
const TYPE_UPDATE_PARTICIPANT_STATUS = 'participant_update_status';
const TYPE_REQUEST_PARTICIPANT_STATUS = 'participant_request_status';

class Room extends Emitter {
  callSession: ?CallSession;
  extension: string;
  sourceId: ?number;
  participants: Participant[];
  callId: ?string;
  connected: boolean;
  localParticipant: ?Participant;
  _callIdStreamIdMap: Object;
  _unassociatedVideoStreams: Object;
  _boundOnParticipantJoined: Function;
  _boundOnParticipantLeft: Function;
  _boundOnScreenshareEnded: Function;
  _boundOnMessage: Function;
  audioStream: ?any;
  audioElement: ?any;
  extra: Object;
  // video tag representing the room audio stream
  roomAudioElement: any;

  CONFERENCE_USER_PARTICIPANT_JOINED: string;
  CONFERENCE_USER_PARTICIPANT_LEFT: string;
  ON_SCREEN_SHARE_ENDED: string;
  ON_MESSAGE: string;
  ON_CHAT: string;
  ON_SIGNAL: string;
  ON_AUDIO_STREAM: string;
  ON_VIDEO_STREAM: string;
  ON_REMOVE_STREAM: string;
  ON_DISCONNECTED: string;
  ON_JOINED: string;
  ON_TALKING: string;

  /**
   *
   * @param callSession CallSession
   * @param extension string
   * @param sourceId number
   * @param callId string
   * @param extra Object
   */
  constructor(callSession: CallSession, extension: string, sourceId: ?number, callId: ?string, extra: Object = {}) {
    super();
    // Represents the room callSession
    this.callSession = callSession;
    this.extension = extension;
    this.sourceId = sourceId;
    this.callId = callId;
    this.participants = [];
    this.connected = false;
    this.localParticipant = null;
    // [callId]: streamId
    this._callIdStreamIdMap = {};
    // Stream not yet associated to a participant, [streamId]: stream
    this._unassociatedVideoStreams = {};

    // The shared audio stream of the room
    this.audioStream = null;
    // Extra values passed to local participant
    this.extra = extra;

    // Sugar syntax for `room.EVENT_NAME`
    this.CONFERENCE_USER_PARTICIPANT_JOINED = Wazo.Websocket.CONFERENCE_USER_PARTICIPANT_JOINED;
    this.CONFERENCE_USER_PARTICIPANT_LEFT = Wazo.Websocket.CONFERENCE_USER_PARTICIPANT_LEFT;
    this.ON_SCREEN_SHARE_ENDED = Wazo.Phone.ON_SCREEN_SHARE_ENDED;
    this.ON_MESSAGE = Wazo.Phone.ON_MESSAGE;
    this.ON_CHAT = 'room_on_chat';
    this.ON_SIGNAL = 'room_on_signal';
    this.ON_AUDIO_STREAM = Wazo.Phone.ON_AUDIO_STREAM;
    this.ON_VIDEO_STREAM = Wazo.Phone.ON_VIDEO_STREAM;
    this.ON_REMOVE_STREAM = Wazo.Phone.ON_REMOVE_STREAM;
    this.ON_DISCONNECTED = 'room_disconnected';
    this.ON_JOINED = 'room_joined';
    this.ON_TALKING = 'room_talking';

    this._boundOnParticipantJoined = this._onParticipantJoined.bind(this);
    this._boundOnParticipantLeft = this._onParticipantLeft.bind(this);
    this._boundOnMessage = this._onMessage.bind(this);
    this._boundOnScreenshareEnded = this._onScreenshareEnded.bind(this);

    this.unbind();

    this._bindEvents();

    this._transferEvents();
  }

  /**
   *
   * @param extension string
   * @param constraints string
   * @returns {Promise<Room>}
   */
  static async connect({ extension, ...constraints }: Object) {
    // @TODO: retrieve only constraints here (eg: avoid extra)
    await Wazo.Phone.connect({ media: constraints });
    Wazo.Phone.checkSfu();

    const callSession = await Wazo.Phone.call(extension, constraints && !!constraints.video);
    const room = new Room(callSession, extension, null, null, constraints.extra);

    // Call_created is triggered before call_accepted, so we have to listen for it here.
    let callId = '';
    Wazo.Websocket.once(Wazo.Websocket.CALL_CREATED, ({ data }) => {
      callId = data.call_id;
    });

    // Wait for the call to be accepted
    await new Promise((resolve, reject) => {
      Wazo.Phone.once(Wazo.Phone.ON_CALL_ACCEPTED, resolve);
      Wazo.Phone.once(Wazo.Phone.ON_CALL_FAILED, reject);
    });

    // Fetch conference source
    const sources = await getApiClient().dird.fetchConferenceSource('default');
    // Retrieve conference sources
    const contacts = await getApiClient().dird.fetchConferenceContacts(sources.items[0]);
    // Retrieve conference
    const conference = contacts.find(contact => contact.numbers.find(number => number.number === extension));

    room.setSourceId(conference.sourceId);
    room.setCallId(callId);

    return room;
  }

  static disconnect() {
    Wazo.Phone.disconnect();
  }

  async disconnect() {
    await Wazo.Phone.hangup(this.callSession);
    this.callSession = null;
    this.eventEmitter.emit(this.ON_DISCONNECTED, this);
    this.connected = false;
    this.unbind();

    Wazo.Phone.off(this.ON_MESSAGE, this._boundOnMessage);
    Wazo.Phone.off(this.ON_SCREEN_SHARE_ENDED, this._boundOnScreenshareEnded);
    Wazo.Websocket.off(this.CONFERENCE_USER_PARTICIPANT_JOINED, this._boundOnParticipantJoined);
    Wazo.Websocket.off(this.CONFERENCE_USER_PARTICIPANT_LEFT, this._boundOnParticipantLeft);

    if (this.roomAudioElement && document.body) {
      document.body.removeChild(this.roomAudioElement);
    }
  }

  setSourceId(sourceId: number) {
    this.sourceId = sourceId;
  }

  setCallId(callId: string) {
    this.callId = callId;
  }

  sendMessage(body: string, sipSession: any = null) {
    return Wazo.Phone.sendMessage(body, sipSession);
  }

  sendChat(content: string) {
    return this.sendMessage(JSON.stringify({ type: TYPE_CHAT, content }));
  }

  sendSignal(content: string) {
    return this.sendMessage(JSON.stringify({ type: TYPE_SIGNAL, content }));
  }

  startScreenSharing(constraints: Object) {
    Wazo.Phone.startScreenSharing(constraints);

    if (this.localParticipant) {
      this.localParticipant.onScreensharing();
      this._sendParticipantStatus(this.localParticipant);
    }
  }

  stopScreenSharing() {
    Wazo.Phone.stopScreenSharing();

    if (this.localParticipant) {
      this.localParticipant.onStopScreensharing();
      this._sendParticipantStatus(this.localParticipant);
    }
  }

  turnCameraOff() {
    Wazo.Phone.turnCameraOff(this.callSession);

    if (this.localParticipant) {
      this.localParticipant.onVideoMuted();
      this._sendParticipantStatus(this.localParticipant);
    }
  }

  turnCameraOn() {
    Wazo.Phone.turnCameraOn(this.callSession);

    if (this.localParticipant) {
      this.localParticipant.onVideoUnMuted();
      this._sendParticipantStatus(this.localParticipant);
    }
  }

  mute() {
    Wazo.Phone.mute(this.callSession);

    if (this.localParticipant) {
      this.localParticipant.onAudioMuted();
      this._sendParticipantStatus(this.localParticipant);
    }
  }

  unmute() {
    Wazo.Phone.unmute(this.callSession);

    if (this.localParticipant) {
      this.localParticipant.onAudioUnMuted();
      this._sendParticipantStatus(this.localParticipant);
    }
  }

  _bindEvents() {
    // Retrieve mapping
    Wazo.Phone.phone.currentSipSession.sessionDescriptionHandler.on('setDescription', ({ type, sdp: rawSdp }) => {
      if (type !== 'offer') {
        return;
      }
      const sdp = sdpParser.parse(rawSdp);
      const labelMsidArray = sdp.media.filter(media => !!media.label).map(({ label, msid }) => ({
        label: String(label),
        msid: msid.split(' ')[1],
      }));

      labelMsidArray.forEach(({ label, msid }) => {
        this._callIdStreamIdMap[String(label)] = msid;
      });
    });

    this.on(this.ON_AUDIO_STREAM, stream => {
      this.audioStream = stream;
      if (document.createElement) {
        this.roomAudioElement = document.createElement('audio');
        this.roomAudioElement.srcObject = stream;
        this.roomAudioElement.autoplay = true;
        if (document.body) {
          document.body.appendChild(this.roomAudioElement);
        }
      }
    });

    this.on(this.ON_VIDEO_STREAM, (stream, streamId) => {
      // ON_VIDEO_STREAM is called before PARTICIPANT_JOINED, so we have to keep stream in `_unassociatedVideoStreams`.
      this._unassociatedVideoStreams[streamId] = stream;
    });

    this.on(this.ON_REMOVE_STREAM, stream => {
      const participant = this.participants.find(someParticipant =>
        someParticipant.streams.find(someStream => someStream.id === stream.id));
      if (!participant) {
        return;
      }

      participant.videoStreams = participant.videoStreams.filter(someStream => someStream.id !== stream.id);
      participant.streams = participant.streams.filter(someStream => someStream.id !== stream.id);
      participant.onStreamUnSubscribed(stream);
    });
  }

  _transferEvents() {
    Wazo.Websocket.on(this.CONFERENCE_USER_PARTICIPANT_JOINED, this._boundOnParticipantJoined);
    Wazo.Websocket.on(this.CONFERENCE_USER_PARTICIPANT_LEFT, this._boundOnParticipantLeft);

    // Phone events
    Wazo.Phone.on(this.ON_MESSAGE, this._boundOnMessage);
    Wazo.Phone.on(this.ON_SCREEN_SHARE_ENDED, this._boundOnScreenshareEnded);

    [this.ON_AUDIO_STREAM, this.ON_VIDEO_STREAM, this.ON_REMOVE_STREAM].forEach(event =>
      Wazo.Phone.on(event, (...args) => this.eventEmitter.emit.apply(this.eventEmitter, [event, ...args])));
  }

  _onMessage(message: SIP.IncomingRequestMessage) {
    if (message.method !== 'MESSAGE') {
      return;
    }
    let body;
    try {
      body = JSON.parse(message.body);
    } catch (e) {
      return;
    }

    switch (body.type) {
      case 'ConfbridgeTalking': {
        // Update participant
        const channel = body.channels[0];
        const { id: callId, talking_status: talkingStatus } = channel;
        const isTalking = talkingStatus === 'on';
        const participantIdx = this.participants.findIndex(participant => participant.callId === callId);
        if (participantIdx === -1) {
          return;
        }
        this.participants[participantIdx].onTalking(isTalking);

        return this.eventEmitter.emit(this.ON_TALKING, channel, this.participants[participantIdx]);
      }

      case TYPE_CHAT:
        return this.eventEmitter.emit(this.ON_CHAT, body.content);

      case TYPE_SIGNAL:
        return this.eventEmitter.emit(this.ON_SIGNAL, body.content);

      case TYPE_UPDATE_PARTICIPANT_STATUS:
        return this._updateParticipantStatus(body.status);

      case TYPE_REQUEST_PARTICIPANT_STATUS:
        return this._sendParticipantStatus(this.localParticipant);

      default:
        break;
    }

    this.eventEmitter.emit(this.ON_MESSAGE, body);
  }

  async _onParticipantJoined(payload: Object) {
    const participant = payload.data;
    const session = Wazo.Auth.getSession();
    let participants = [];

    // When we join the room, we can call `getConferenceParticipantsAsUser`, not before.
    if (participant.user_uuid === session.uuid) {
      // Retrieve participants via an API calls
      const response = await getApiClient().calld.getConferenceParticipantsAsUser(this.sourceId);
      if (response) {
        participants = response.items.map(item => {
          const isMe = item.call_id === this.callId;

          return isMe ? new Wazo.LocalParticipant(item, this.extra) : new Wazo.RemoteParticipant(item);
        });
      }
    } else {
      participants = [new Wazo.RemoteParticipant(participant)];
      // We can't send our status here, because for other participants the api request that retrieve all participants
      // can be slow and we may not be in the list of participants for now.
    }

    this.participants = [...this.participants, ...participants];

    const localParticipant = participants.find(someParticipant => someParticipant instanceof Wazo.LocalParticipant);
    if (!this.localParticipant && localParticipant) {
      const videoStream = new Wazo.Stream(this._getLocalVideoStream(), localParticipant);
      if (videoStream) {
        localParticipant.streams.push(videoStream);
        localParticipant.videoStreams.push(videoStream);
        localParticipant.onStreamSubscribed(videoStream);
      }
      this.localParticipant = localParticipant;

      // Send our status to all participants when we enter the room
      this._sendParticipantStatus(localParticipant);
      this._requestParticipantsStatus();

      this.connected = true;

      this.eventEmitter.emit(this.ON_JOINED, localParticipant);
    }

    participants.forEach(someParticipant => {
      this.eventEmitter.emit(this.CONFERENCE_USER_PARTICIPANT_JOINED, someParticipant);
      this.__associateStreams(someParticipant);
    });

    return participants;
  }

  _onParticipantLeft(payload: Object) {
    const leftParticipant = this.participants.find(participant => participant.callId === payload.data.call_id);
    // Trigger Participant.ON_DISCONNECT event
    if (leftParticipant) {
      leftParticipant.onDisconnect();
    }

    this.participants = this.participants.filter(participant => participant.callId !== payload.data.call_id);
    this.eventEmitter.emit(this.CONFERENCE_USER_PARTICIPANT_LEFT, leftParticipant);
  }

  _onScreenshareEnded() {
    this.eventEmitter.emit(this.ON_SCREEN_SHARE_ENDED);
    if (this.localParticipant) {
      this.localParticipant.onStopScreensharing();
    }
    this._sendParticipantStatus(this.localParticipant);
  }

  // Sends a `TYPE_UPDATE_PARTICIPANT_STATUS` to all participants of the room
  _sendParticipantStatus(participant: ?Participant) {
    if (!participant) {
      return;
    }

    this.sendMessage(JSON.stringify({
      type: TYPE_UPDATE_PARTICIPANT_STATUS,
      status: participant.getStatus(),
    }));
  }

  // Called when we receive a `TYPE_PARTICIPANT_STATUS` for a participant
  _updateParticipantStatus(rawStatus: Object) {
    const status = rawStatus;
    const { callId } = status;
    delete status.callId;
    const participant = this._getParticipantFromCallId(callId);
    if (!participant) {
      return;
    }

    participant.updateStatus(status);
  }

  _requestParticipantsStatus() {
    this.sendMessage(JSON.stringify({
      type: TYPE_REQUEST_PARTICIPANT_STATUS,
    }));
  }

  // Associate audio/video streams to the participant and triggers events on it
  __associateStreams(participant: Participant) {
    const streamId = this._callIdStreamIdMap[participant.callId];
    if (!streamId || !participant || !this.localParticipant || participant.callId === this.localParticipant.callId) {
      return;
    }

    if (this._unassociatedVideoStreams[streamId]) {
      // Try to associate stream
      const stream = new Wazo.Stream(this._unassociatedVideoStreams[streamId], participant);
      participant.streams.push(stream);
      participant.videoStreams.push(stream);

      participant.onStreamSubscribed(stream);

      delete this._unassociatedVideoStreams[streamId];
    }
  }

  _getCallIdFromStreamId(streamId: string) {
    return Object.keys(this._callIdStreamIdMap).find(key => this._callIdStreamIdMap[key] === streamId);
  }

  _getParticipantFromCallId(callId: string) {
    return this.participants.find(participant => participant.callId === callId);
  }

  _getLocalVideoStream() {
    return Wazo.Phone.getLocalVideoStream(this.callSession);
  }
}

export default Room;

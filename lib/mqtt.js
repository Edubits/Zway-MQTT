/*** MQTTClient **************************************************************

Based on https://github.com/leizongmin/MQTTClient

 *****************************************************************************/

'use strict';

/**
 * MQTTClient constructor
 * NOTE: Explicitely exposes everything publically, private indicated by "_"
 */
function MQTTClient(host, port, options) {
  // Default port
  if (isNaN(port))
    port = 1883;

  // Default options override
  var defaultOptions = {
    username: undefined,
    password: undefined,
    will_flag: undefined,
    will_retain: undefined,
    will_message: undefined,
    will_topic: undefined,
    client_id: 'a' + new Date().getTime() + parseInt(Math.random() * 1000),
    ping_timeout: 30,
    ping_interval: 18000,
    connect_timeout: 10,
    infoLogEnabled: false
  };

  if (typeof options.ping_timeout != 'undefined')
    options.ping_interval = parseInt(this.options.ping_timeout * 0.6 * 1000);

  // Options validation
  if (typeof options.username == 'string' && options.username.length > 12)
    throw Error('user names are kept to 12 characters or fewer');

  if (typeof options.password == 'string' && options.password.length > 12)
    throw Error('passwords are kept to 12 characters or fewer');

  if (options.will_flag && (typeof options.will_topic != 'string' || typeof options.will_message != 'string'))
    throw Error('missing will_topic or will_message when will_flag is set');

  // Build options
  this.options = defaultOptions;
  for (var attrname in options) { this.options[attrname] = options[attrname]; }

  this.host = host;
  this.port = port;

  this.connected = false;
  this._last_message_id = 0;

  // Timers
  this._connect_timeout_timer = undefined;
  this._ping_timer = undefined;
  this._ping_timeout_timer = undefined;

  // External callbacks
  this._logCallback = undefined;
  this._errorCallback = undefined;

  this._connectionCallback = undefined;
  this._disconnectCallback = undefined;

  this._message_callback = {};
  this._subscriptionCallbacks = {};
};

// MQTT Message type mappings
MQTTClient.messageTypes = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  PUBREC: 5,
  PUBREL: 6,
  PUBCOMP: 7,
  SUBSCRIBE: 8,
  SUBACK: 9,
  UNSUBSCRIBE: 10,
  UNSUBACK: 11,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14
};

/**
 * Public static helper functions
 */
MQTTClient.buildFixedHeader = function (message_type, dup_flag, qos_level, retain, remaining_length) {
  var la = [];
  var x = remaining_length;
  var d;
  do {
    d = x % 128;
    x = Math.floor(x / 128);
    if (x > 0)
      d = d | 0x80;
    la.push(d);
  } while (x > 0);

  var ret = new Buffer(la.length + 1);
  ret[0] = (message_type << 4) + (dup_flag << 3) + (qos_level << 1) + (retain ? 1 : 0);
  for (var i = 1; i < ret.length; i++)
    ret[i] = la[i - 1];
  return ret;
};

MQTTClient.buildMessage = function () {
  var length = 0;
  for (var i = 0; i < arguments.length; i++)
    length += arguments[i].length;
  var ret = new Buffer(length);

  var cur = 0;
  for (i = 0; i < arguments.length; i++) {
    var l = arguments[i].length;
    arguments[i].copy(ret, cur, 0, l);
    cur += l;
  }
  return ret;
};

MQTTClient.decodeHeader = function (fixed_header) {
  var ret = {};
  var b1 = fixed_header[0];
  ret.message_type = b1 >> 4;
  ret.dup_flag = (b1 >> 3) & 1;
  ret.qos_level = (b1 >> 1) & 3;
  ret.retain = b1 & 1;

  var m = 1;
  var v = 0;
  var i = 1;
  do {
    var d = fixed_header[i++];
    if (typeof d == 'undefined')
      return false;
    v += (d & 127) * m;
    m *= 128;
  } while ((d & 128) != 0);
  ret.remaining_length = v;
  ret.fixed_header_length = i;

  return ret;
};

/**
 * Callback assignments
 */
MQTTClient.prototype.onError = function (callback) { this._errorCallback = callback; };
MQTTClient.prototype.onLog = function (callback) { this._logCallback = callback; };
MQTTClient.prototype.onDisconnect = function (callback) { this._disconnectCallback = callback; };

/**
 * Public interface
 */
MQTTClient.prototype.connect = function (callback) {
  var self = this;

  this._connectionCallback = callback;

  // Setup socket
  this._connection = new sockets.tcp();
  this._connection.onrecv = function (chunk) {
    self._onData(new Buffer(new Uint8Array(chunk)));
  };

  this._connection.onclose = function () {
    self._onClose();
  };

  if (this._connection.connect(self.host, self.port)) {
    this._startSession();
  } else {
    this._onError('Could not connect to ' + this.host + ':' + this.port);
  }
};

// Do not call from within class
MQTTClient.prototype.close = function () {
  var self = this;

  if (this.connected === true)
    this._connection.close();
};

MQTTClient.prototype.publish = function (topic, payload, options, callback) {
  if (!this.connected) {
    this._onError(Error('Please connect to server first'));
    return;
  }

  if (!Buffer.isBuffer(topic))
    topic = new Buffer(topic);
  if (!Buffer.isBuffer(payload))
    payload = new Buffer(payload);
  if (!options)
    options = {};

  // Variable header
  // Topic name
  var topic_length = new Buffer(2);
  topic_length[0] = topic.length >> 8;
  topic_length[1] = topic.length & 0xFF;
  var topic_name = MQTTClient.buildMessage(topic_length, topic);

  // Message ID
  var message_id;
  if (options.qos_level > 0) {
    message_id = new Buffer(2);
    this._last_message_id++;
    message_id[0] = this._last_message_id >> 8;
    message_id[1] = this._last_message_id & 0xFF;
  } else {
    message_id = new Buffer(0);
  }

  // Fixed header
  var fixed_header = MQTTClient.buildFixedHeader(MQTTClient.messageTypes.PUBLISH,
      options.dup_flag, options.qos_level, options.retain,
      topic_name.length + message_id.length + payload.length);

  var buffer = MQTTClient.buildMessage(fixed_header, topic_name, message_id, payload);
  this._send(buffer);

  if (options.qos_level > 0 && typeof callback == 'function')
    this._message_callback[this._last_message_id] = callback;
};

MQTTClient.prototype.subscribe = function (topic, options, callback) {
  if (!this.connected) {
    this._onError(Error('Please connect to server first'));
    return;
  }

  if (!Buffer.isBuffer(topic))
    topic = new Buffer(topic);
  if (!options)
    options = {};

  // Variable header
  // Message Identifier
  var message_id = new Buffer(2);
  this._last_message_id++;
  message_id[0] = this._last_message_id >> 8;
  message_id[1] = this._last_message_id & 0xFF;

  // Payload
  var topic_length = new Buffer(2);
  topic_length[0] = topic.length >> 8;
  topic_length[1] = topic.length & 0xFF;
  var requested_qos = new Buffer(1);
  requested_qos[0] = options.qos_level & 0x03;
  var payload = MQTTClient.buildMessage(topic_length, topic, requested_qos);

  // Fixed Header
  var fixed_header = MQTTClient.buildFixedHeader(MQTTClient.messageTypes.SUBSCRIBE, options.dup_flag, 1, 0,
      message_id.length + payload.length);

  var buffer = MQTTClient.buildMessage(fixed_header, message_id, payload);
  this._send(buffer);

  if (typeof callback == 'function')
    this._subscriptionCallbacks[topic] = callback;
};

/**
 * Internal event handlers.
 */
MQTTClient.prototype._onError = function (error) {
  if (typeof this._errorCallback == 'function')
    this._errorCallback(error);
};

MQTTClient.prototype._onLog = function (log) {
  if (typeof this._logCallback == 'function')
    this._logCallback(log);
};

MQTTClient.prototype._onConnect = function () {
  this._onLog("Socket connection opened.");
  if (typeof this._connectionCallback == 'function')
    this._connectionCallback();
};

MQTTClient.prototype._onClose = function () {
  this.connected = false;

  // Kill any remaining timeouts
  this._clearConnectTimer();
  this._clearPingTimer();
  this._clearPingTimeoutTimer();

  this._connection = null;

  this._onLog("Socket connection closed.");

  if (typeof this._disconnectCallback == 'function')
    this._disconnectCallback();
};

MQTTClient.prototype._onTimeout = function () {
  this._onError(Error('Timeout'));
  this._connection.close();
};

MQTTClient.prototype._onData = function (chunk) {
  if (Buffer.isBuffer(this._fixed_header_chunk)) {
    this._onData(MQTTClient.buildMessage(this._fixed_header_chunk, chunk));
  } else {
    var fixed_header = MQTTClient.decodeHeader(chunk);
    if (fixed_header == false) {
      this._fixed_header_chunk = chunk;
    } else {
      if (this.options.infoLogEnabled === true)
        this._onLog("IN: " + fixed_header.message_type + ": " + chunk.toString('hex'));

      var handler = MQTTClient.messageHandlers[fixed_header.message_type];
      if (typeof handler != 'function')
        this._onError(Error('Message type error: ' + fixed_header.message_type));
      else
        handler(this, fixed_header, chunk);
    }
  }
};

MQTTClient.prototype._onPublish = function (topic, payload) {
  var topicStr = topic.toString();
  for (var subscriptionTopic in this._subscriptionCallbacks) {
    if (subscriptionTopic == topic) {
      this._subscriptionCallbacks[subscriptionTopic](topic, payload.toString());
    }

    if (subscriptionTopic.indexOf('#') > 0
        && topicStr.indexOf(subscriptionTopic.substr(0, subscriptionTopic.length - 1)) == 0) {
      this._subscriptionCallbacks[subscriptionTopic](topic, payload.toString());
    }
  }
};

/**
 * Internal private methods
 */
MQTTClient.prototype._clearPingTimer = function () {
  if (this._ping_timer) {
    clearTimeout(this._ping_timer);
    this._ping_timer = null;
  }
};

MQTTClient.prototype._clearPingTimeoutTimer = function () {
  if (this._ping_timeout_timer) {
    clearTimeout(this._ping_timeout_timer);
    this._ping_timeout_timer = null;
  }
};

MQTTClient.prototype._clearConnectTimer = function () {
  if (this._connect_timeout_timer) {
    clearTimeout(this._connect_timeout_timer);
    this._connect_timeout_timer = null;
  }
};

MQTTClient.prototype._startSession = function () {
  var self = this;

  var variable_header = new Buffer(12);
  variable_header[0] = 0x00;
  variable_header[1] = 0x06;
  variable_header[2] = 0x4d;	// 'M'
  variable_header[3] = 0x51;	// 'Q'
  variable_header[4] = 0x49;	// 'I'
  variable_header[5] = 0x73;	// 's'
  variable_header[6] = 0x64;	// 'd'
  variable_header[7] = 0x70;	// 'p'
  variable_header[8] = 0x03;	// Protocol Version Number

  // Connect Flags
  variable_header[9] = ((this.options.username ? 1 : 0) << 7) +
      ((this.options.password ? 1 : 0) << 6) +
      (this.options.will_retain << 5) +
      (this.options.will_qos << 3) +
      (this.options.will_flag << 2) +
      (this.options.clean_session << 1);

  // Keep Alive timer
  var timer = this.options.ping_timeout;
  variable_header[10] = timer >> 8;
  variable_header[11] = timer & 0xFF;

  if (this.options.infoLogEnabled === true)
    this._onLog("CNCT VAR HEAD: " + variable_header.toString('hex'));

  // Payload
  // MQTTClient Identifier
  var client_id = new Buffer(this.options.client_id);
  var client_id_length = new Buffer(2);
  client_id_length[0] = client_id.length >> 8;
  client_id_length[1] = client_id.length & 0xFF;

  // Will Topic
  var will_topic, will_topic_length, username, username_length, password, password_length;
  if (this.options.will_flag && this.options.will_topic) {
    will_topic = new Buffer(this.options.will_topic);
    will_topic_length = new Buffer(2);
    will_topic_length[0] = will_topic.length >> 8;
    will_topic_length[1] = will_topic.length & 0xFF;
  } else {
    will_topic = new Buffer(0);
    will_topic_length = new Buffer(0);
  }

  // Will Message
  if (this.options.will_message && this.options.will_message) {
    will_message = new Buffer(this.options.will_message);
    will_message_length = new Buffer(2);
    will_message_length[0] = will_message.length >> 8;
    will_message_length[1] = will_message.length & 0xFF;
  } else {
    var will_message = new Buffer(0);
    var will_message_length = new Buffer(0);
  }

  // User Name
  if (this.options.username) {
    username = new Buffer(this.options.username);
    username_length = new Buffer(2);
    username_length[0] = username.length >> 8;
    username_length[1] = username.length & 0xFF;
  } else {
    username = new Buffer(0);
    username_length = new Buffer(0);
  }

  // Password
  if (this.options.password) {
    password = new Buffer(this.options.password);
    password_length = new Buffer(2);
    password_length[0] = password.length >> 8;
    password_length[1] = password.length & 0xFF;
  } else {
    password = new Buffer(0);
    password_length = new Buffer(0);
  }

  // Payload
  var payload = MQTTClient.buildMessage(client_id_length, client_id,
      will_topic_length, will_topic,
      will_message_length, will_message,
      username_length, username,
      password_length, password);

  if (this.options.infoLogEnabled === true)
    this._onLog("CNCT PAYLOAD: " + payload.toString('hex'));

  // Fixed Header
  var fixed_header = MQTTClient.buildFixedHeader(MQTTClient.messageTypes.CONNECT, 0, 0, false, variable_header.length + payload.length);

  if (this.options.infoLogEnabled === true)
    this._onLog("CNCT FIXED HEAD: " + fixed_header.toString('hex'));

  var buffer = MQTTClient.buildMessage(fixed_header, variable_header, payload);

  // Setup connect timeout
  this._connect_timeout_timer = setTimeout(function() {
                                  self._connect_timeout_timer = null;
                                }, this.options.connect_timeout * 1000);

  this._send(buffer);
};

MQTTClient.prototype._send = function (buffer) {
  if (this.options.infoLogEnabled === true)
    this._onLog("OUT: " + buffer.toString('hex'));

  this._connection.send(buffer.toString('binary'));
};

MQTTClient.prototype._response = function (qos_level, message_id) {
  var buffer = new Buffer(4);
  if (qos_level == 1)
    buffer[0] = MQTTClient.messageTypes.PUBACK << 4;
  else
    buffer[0] = MQTTClient.messageTypes.PUBREC << 4;
  buffer[1] = qos_level << 1;
  buffer[2] = message_id >> 8;
  buffer[3] = message_id & 0xFF;

  this._send(buffer);
};

MQTTClient.prototype._ping = function () {
  var self = this;

  if (!this.connected) {
    this._onError(Error('Please connect to server first'));
    return;
  }

  // Do not send another ping if still awaiting a response, new ping will be setup by PING message handler
  if (this._ping_timeout_timer) {
    return;
  }

  // Build ping request
  var buffer = new Buffer(2);
  buffer[0] = MQTTClient.messageTypes.PINGREQ << 4;
  buffer[1] = 0x00;

  // Setup ping timeout
  this._ping_timeout_timer = setTimeout(function() {
                                self._ping_timeout_timer = null;
                                self._onTimeout();
                              }, this.options.ping_timeout * 1000);

  // Send ping request
  this._send(buffer);
};

/**
 * Message Handlers.
 * NOTE: Remember to pass scope as first param!
 */
MQTTClient.messageHandlers = [];
MQTTClient.messageHandlers[MQTTClient.messageTypes.CONNACK] = function (self, fixed_header, chunk) {
  // Clear timeout
  self._clearConnectTimer();

  if (chunk.length < 4) {
    self._onError(Error('CONNACK format error'));
  } else {
    var code = chunk[3];
    if (code == 0) {
      self.connected = true;
      self._last_message_id = 0;

      self._ping_timer = setTimeout(function () {
                           self._ping();
                         }, 
                         self.options.ping_interval);

      self._onConnect();
    } else if (code > 0 && code < 6) {
      var msg = ['Successed',
                  'Connection Refused: unacceptable protocol version',
                  'Connection Refused: identifier rejected',
                  'Connection Refused: server unavailable',
                  'Connection Refused: bad user name or password',
                  'Connection Refused: not authorized'];

      self._onError(Error(msg[code]));
      self.connected = false;
    } else {
      self._onError(Error('Unknown Error: #' + code));
      self.connected = false;
    }
  }
};

MQTTClient.messageHandlers[MQTTClient.messageTypes.PUBACK] = function (self, fixed_header, chunk) {
  if (chunk.length < 4)
    self._onError(Error('CONNACK format error'));
  else {
    var message_id = (chunk[2] << 8) + chunk[3];
    var callback = self._message_callback[message_id];
    if (typeof callback == 'function') {
      callback(message_id);
      delete self._message_callback[message_id];
    }
  }
};

MQTTClient.messageHandlers[MQTTClient.messageTypes.PUBREC] = function (self, fixed_header, chunk) {
  if (chunk.length < 4)
    self._onError(Error('PUBREC format error'));
  else {
    var pubrel = chunk.slice(0, 4);
    pubrel[0] = 0x62;
    self._connection.write(pubrel);
  }
};

MQTTClient.messageHandlers[MQTTClient.messageTypes.PUBCOMP] = function (self, fixed_header, chunk) {
  if (chunk.length < 4)
    self._onError(Error('PUBCOMP format error'));
  else {
    var message_id = (chunk[2] << 8) + chunk[3];
    var callback = self._message_callback[message_id];
    if (typeof callback == 'function') {
      callback(message_id);
      delete self._message_callback[message_id];
    }
  }
};

MQTTClient.messageHandlers[MQTTClient.messageTypes.SUBACK] = function (self, fixed_header, chunk) {
  if (chunk.length < 5)
    self._onError(Error('SUBACK format error'));
  else {
    var message_id = (chunk[2] << 8) + chunk[3];
    var callback = self._message_callback[message_id];
    if (typeof callback == 'function') {
      var qos_level = chunk[4];
      callback(qos_level);
      delete self._message_callback[message_id];
    }
  }
};

MQTTClient.messageHandlers[MQTTClient.messageTypes.UNSUBACK] = function (self, fixed_header, chunk) {
  if (chunk.length < 4)
    self._onError(Error('UNSUBACK format error'));
  else {
    var message_id = (chunk[2] << 8) + chunk[3];
    var callback = self._message_callback[message_id];
    if (typeof callback == 'function') {
      callback();
      delete self._message_callback[message_id];
    }
  }
};

MQTTClient.messageHandlers[MQTTClient.messageTypes.PINGRESP] = function (self, fixed_header, chunk) {
  if (chunk.length < 2) {
    self._onError(Error('PINGRESP format error'));
  } else {
    // Kill ping timeout
    self._clearPingTimeoutTimer();

    // Setup next ping request
    self._ping_timer = setTimeout(function () {
                          self._ping();
                        }, self.options.ping_interval);
  }
};

MQTTClient.messageHandlers[MQTTClient.messageTypes.PUBLISH] = function (self, fixed_header, chunk) {
  if (self._data_not_enough) {
    if (self._data_offset + chunk.length >= self._data_length) {
      self._data_not_enough = false;
      self.messageHandlers[self.messageTypes.PUBLISH](self, fixed_header, MQTTClient.buildMessage(self._data_chunk, chunk));
    } else {
      chunk.copy(self._data_chunk, self._data_offset, 0, chunk.length);
      self._data_offset += chunk.length;
    }
  } else {
    var data_length = fixed_header.fixed_header_length + fixed_header.remaining_length;
    var payload;
    
    if (chunk.length >= data_length) {
      var topic_length = (chunk[fixed_header.fixed_header_length] << 8) +
          chunk[fixed_header.fixed_header_length + 1];
      var topic = chunk.slice(fixed_header.fixed_header_length + 2,
          fixed_header.fixed_header_length + 2 + topic_length);
      
      if (fixed_header.qos_level > 0) {
        var message_id = (chunk[fixed_header.fixed_header_length + 2 + topic_length] << 8) +
            chunk[fixed_header.fixed_header_length + 3 + topic_length];
        payload = chunk.slice(fixed_header.fixed_header_length + 2 + topic_length + 2,
            fixed_header.fixed_header_length + fixed_header.remaining_length);
      } else {
        message_id = 0;
        payload = chunk.slice(fixed_header.fixed_header_length + 2 + topic_length,
            fixed_header.fixed_header_length + fixed_header.remaining_length);
      }

      self._onPublish(topic, payload);
      delete self._data_chunk;
      delete self._last_fixed_header;
      
      if (fixed_header.qos_level > 0)
        self._response(fixed_header.qos_level, message_id);

      if (chunk.length > data_length) {
        self._onData(chunk.slice(
            fixed_header.fixed_header_length + fixed_header.remaining_length,
            chunk.length
        ));
      }
    } else {
      self._data_not_enough = true;
      self._data_length = data_length;
      self._data_chunk = new Buffer(data_length);
      chunk.copy(self._data_chunk, 0, 0, chunk.length);
      self._data_offset = chunk.length;
      self._last_fixed_header = fixed_header;
    }
  }
};

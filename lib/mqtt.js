/*** MQTTClient **************************************************************

Based on https://github.com/leizongmin/MQTTClient

 *****************************************************************************/

var MQTTClient = function (host, port, options) {
  if (isNaN(port))
    port = 1883;
  if (!options)
    options = {
      username: undefined,
      password: undefined,
      will_flag: undefined,
      will_retain: undefined,
      will_message: undefined,
      will_topic: undefined
    };
  if (typeof options.client_id == 'undefined')
    options.client_id = 'a' + new Date().getTime() + parseInt(Math.random() * 1000);
  if (isNaN(options.alive_timer) || options.alive_timer < 1)
    options.alive_timer = 30;
  options.ping_timer = parseInt(options.alive_timer * 0.6 * 1000);
  if (typeof options.username == 'string' && options.username.length > 12)
    throw Error('user names are kept to 12 characters or fewer');
  if (typeof options.password == 'string' && options.password.length > 12)
    throw Error('passwords are kept to 12 characters or fewer');
  if (options.will_flag && (typeof options.will_topic != 'string' || typeof options.will_message != 'string'))
    throw Error('missing will_topic or will_message when will_flag is set');

  this.host = host;
  this.port = port;
  this.options = options;
  this.connected = false;
  this._message_callback = {};
  this._last_message_id = 0;
  this._subscriptionCallbacks = {};
  this._errorCallback = undefined;
  this._connectionCallback = undefined;
  this._disconnectCallback = undefined;
};

MQTTClient.CONNECT = 1;
MQTTClient.CONNACK = 2;
MQTTClient.PUBLISH = 3;
MQTTClient.PUBACK = 4;
MQTTClient.PUBREC = 5;
MQTTClient.PUBREL = 6;
MQTTClient.PUBCOMP = 7;
MQTTClient.SUBSCRIBE = 8;
MQTTClient.SUBACK = 9;
MQTTClient.UNSUBSCRIBE = 10;
MQTTClient.UNSUBACK = 11;
MQTTClient.PINGREQ = 12;
MQTTClient.PINGRESP = 13;
MQTTClient.DISCONNECT = 14;

MQTTClient.fixedHeader = function (message_type, dup_flag, qos_level, retain, remaining_length) {
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

MQTTClient.connect = function () {
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

MQTTClient.messageHandlers = [];

MQTTClient.messageHandlers[MQTTClient.CONNACK] = function (self, fixed_header, chunk) {
  if (chunk.length < 4)
    self._onError(Error('CONNACK format error'));
  else {
    var code = chunk[3];
    if (code == 0) {
      self.connected = true;
      self._last_message_id = 0;
      setTimeout(function () {
        self.ping();
      }, self.options.ping_timer);
      self._onConnect();
    }
    else if (code > 0 && code < 6) {
      var msg = ['Successed',
        'Connection Refused: unacceptable protocol version',
        'Connection Refused: identifier rejected',
        'Connection Refused: server unavailable',
        'Connection Refused: bad user name or password',
        'Connection Refused: not authorized'
      ];
      self._onError(Error(msg[code]));
      self.connected = false;
    }
    else {
      self._onError(Error('Unknow Error: #' + code));
      self.connected = false;
    }
  }
};

MQTTClient.messageHandlers[MQTTClient.PUBACK] = function (self, fixed_header, chunk) {
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

MQTTClient.messageHandlers[MQTTClient.PUBREC] = function (self, fixed_header, chunk) {
  if (chunk.length < 4)
    self._onError(Error('PUBREC format error'));
  else {
    var pubrel = chunk.slice(0, 4);
    pubrel[0] = 0x62;
    self.connection.write(pubrel);
  }
};

MQTTClient.messageHandlers[MQTTClient.PUBCOMP] = function (self, fixed_header, chunk) {
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

MQTTClient.messageHandlers[MQTTClient.SUBACK] = function (self, fixed_header, chunk) {
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

MQTTClient.messageHandlers[MQTTClient.UNSUBACK] = function (self, fixed_header, chunk) {
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

MQTTClient.messageHandlers[MQTTClient.PINGRESP] = function (self, fixed_header, chunk) {
  if (chunk.length < 2)
    self._onError(Error('PINGRESP format error'));
  else {
    // log('mqtt::PINGRESP');
    self._wait_for_pingresp = false;
    setTimeout(function () {
      self.ping();
    }, self.options.ping_timer);
  }
};

MQTTClient.messageHandlers[MQTTClient.PUBLISH] = function (self, fixed_header, chunk) {
  if (self._data_not_enough) {
    if (self._data_offset + chunk.length >= self._data_length) {
      self._data_not_enough = false;
      MQTTClient.messageHandlers[MQTTClient.PUBLISH](self, fixed_header, MQTTClient.connect(self._data_chunk, chunk));
    }
    else {
      chunk.copy(self._data_chunk, self._data_offset, 0, chunk.length);
      self._data_offset += chunk.length;
    }
  }
  else {
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
      }
      else {
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
    }
    else {
      self._data_not_enough = true;
      self._data_length = data_length;
      self._data_chunk = new Buffer(data_length);
      chunk.copy(self._data_chunk, 0, 0, chunk.length);
      self._data_offset = chunk.length;
      self._last_fixed_header = fixed_header;
    }
  }
};

MQTTClient.prototype.connect = function (callback) {
  var self = this;
  this._connectionCallback = callback;

  self.reconnect();
};

MQTTClient.prototype.reconnect = function () {
  var self = this;

  this._connection = new sockets.tcp();

  this._connection.onrecv = function (chunk) {
    self._onData(new Buffer(new Uint8Array(chunk)));
  };

  this._connection.onclose = function () {
    self._onClose();
  };

  if (this._connection.connect(self.host, self.port)) {
    self.connection = {};
    self.connection.write = function (buffer) {
      self._connection.send(buffer.toString('binary'));
    };
    self._startSession();
  } else {
    self.onError('Could not connect to ' + self.host + ':' + self.port);
  }
};

MQTTClient.prototype._startSession = function () {
  var variable_header = new Buffer(12);
  variable_header[0] = 0x00;
  variable_header[1] = 0x06;
  variable_header[2] = 0x4d;	// 'M'
  variable_header[3] = 0x51;	// 'Q'
  variable_header[4] = 0x49;	// 'I'
  variable_header[5] = 0x73;	// 's'
  variable_header[6] = 0x64;	// 'd'
  variable_header[7] = 0x70;	// 'p'
  // Protocol Version Number
  variable_header[8] = 0x03;	// Version
  // Connect Flags
  var opt = this.options;
  variable_header[9] = ((opt.username ? 1 : 0) << 7) +
      ((opt.password ? 1 : 0) << 6) +
      (opt.will_retain << 5) +
      (opt.will_qos << 3) +
      (opt.will_flag << 2) +
      (opt.clean_session << 1);
  // Keep Alive timer
  var timer = this.options.alive_timer;
  variable_header[10] = timer >> 8;
  variable_header[11] = timer & 0xFF;

  // Payload
  // MQTTClient Identifier
  var client_id = new Buffer(this.options.client_id);
  var client_id_length = new Buffer(2);
  client_id_length[0] = client_id.length >> 8;
  client_id_length[1] = client_id.length & 0xFF;
  // Will Topic

  var will_topic, will_topic_length, username, username_length, password, password_length;

  if (opt.will_flag && opt.will_topic) {
    will_topic = new Buffer(opt.will_topic);
    will_topic_length = new Buffer(2);
    will_topic_length[0] = will_topic.length >> 8;
    will_topic_length[1] = will_topic.length & 0xFF;
  }
  else {
    will_topic = new Buffer(0);
    will_topic_length = new Buffer(0);
  }
  // Will Message
  if (opt.will_message && opt.will_message) {
    will_message = new Buffer(opt.will_message);
    will_message_length = new Buffer(2);
    will_message_length[0] = will_message.length >> 8;
    will_message_length[1] = will_message.length & 0xFF;
  }
  else {
    var will_message = new Buffer(0);
    var will_message_length = new Buffer(0);
  }
  // User Name
  if (opt.username) {
    username = new Buffer(opt.username);
    username_length = new Buffer(2);
    username_length[0] = username.length >> 8;
    username_length[1] = username.length & 0xFF;
  }
  else {
    username = new Buffer(0);
    username_length = new Buffer(0);
  }
  // Password
  if (opt.password) {
    password = new Buffer(opt.password);
    password_length = new Buffer(2);
    password_length[0] = password.length >> 8;
    password_length[1] = password.length & 0xFF;
  }
  else {
    password = new Buffer(0);
    password_length = new Buffer(0);
  }
  // Payload
  var payload = MQTTClient.connect(client_id_length, client_id,
      will_topic_length, will_topic,
      will_message_length, will_message,
      username_length, username,
      password_length, password);

  // Fixed Header
  var fixed_header = MQTTClient.fixedHeader(MQTTClient.CONNECT, 0, 0, false, variable_header.length + payload.length);

  var buffer = MQTTClient.connect(fixed_header, variable_header, payload);
  this.connection.write(buffer);
};

MQTTClient.prototype._onEnd = function () {
  this._onClose();
};

MQTTClient.prototype._onTimeout = function () {
  this._onError(Error('Timeout'));
	this._connection.close();
};

MQTTClient.prototype._onError = function (error) {
  if (typeof this._errorCallback == 'function')
    this._errorCallback(error);
};

MQTTClient.prototype._onConnect = function () {
  if (typeof this._connectionCallback == 'function')
    this._connectionCallback();
};

MQTTClient.prototype._onClose = function () {
  this.connected = false;
  delete this.connection;

  if (typeof this._disconnectCallback == 'function') {
	  this._disconnectCallback();
  }
};

MQTTClient.prototype._onData = function (chunk) {
  if (Buffer.isBuffer(this._fixed_header_chunk)) {
    this._onData(MQTTClient.connect(this._fixed_header_chunk, chunk));
  } else {
    var fixed_header = MQTTClient.decodeHeader(chunk);
    if (fixed_header == false) {
      this._fixed_header_chunk = chunk;
    }
    else {
      var handler = MQTTClient.messageHandlers[fixed_header.message_type];
      if (typeof handler != 'function')
        this._onError(Error('Message type error: ' + fixed_header.message_type));
      else
        handler(this, fixed_header, chunk);
    }
  }
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
  var topic_name = MQTTClient.connect(topic_length, topic);
  // Message ID
  var message_id;
  if (options.qos_level > 0) {
    message_id = new Buffer(2);
    this._last_message_id++;
    message_id[0] = this._last_message_id >> 8;
    message_id[1] = this._last_message_id & 0xFF;
  }
  else {
    message_id = new Buffer(0);
  }

  // Fixed header
  var fixed_header = MQTTClient.fixedHeader(MQTTClient.PUBLISH,
      options.dup_flag, options.qos_level, options.retain,
      topic_name.length + message_id.length + payload.length);

  var buffer = MQTTClient.connect(fixed_header, topic_name, message_id, payload);
  this.connection.write(buffer);

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
  var payload = MQTTClient.connect(topic_length, topic, requested_qos);
  // Fixed Header
  var fixed_header = MQTTClient.fixedHeader(MQTTClient.SUBSCRIBE, options.dup_flag, 1, 0,
      message_id.length + payload.length);

  var buffer = MQTTClient.connect(fixed_header, message_id, payload);
  // debug(buffer);
  this.connection.write(buffer);

  if (typeof callback == 'function')
    this._subscriptionCallbacks[topic] = callback;
};

MQTTClient.prototype.ping = function () {
  var self = this;
  if (!this.connected) {
    this._onError(Error('Please connect to server first'));
    return;
  }

  var buffer = new Buffer(2);
  buffer[0] = MQTTClient.PINGREQ << 4;
  buffer[1] = 0x00;

  this._wait_for_pingresp = true;
  setTimeout(function () {
    if (self._wait_for_pingresp)
      self._onTimeout();
  }, this.options.alive_timer * 1000);

  this.connection.write(buffer);
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

MQTTClient.prototype._response = function (qos_level, message_id) {
  var buffer = new Buffer(4);
  if (qos_level == 1)
    buffer[0] = MQTTClient.PUBACK << 4;
  else
    buffer[0] = MQTTClient.PUBREC << 4;
  buffer[1] = qos_level << 1;
  buffer[2] = message_id >> 8;
  buffer[3] = message_id & 0xFF;

  this.connection.write(buffer);
};

MQTTClient.prototype.onError = function (callback) {
  this._errorCallback = callback;
};

MQTTClient.prototype.onDisconnect = function (callback) {
  this._disconnectCallback = callback;
};
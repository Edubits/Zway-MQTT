/*** MQTT Z-Way HA module ****************************************************

Version: 1.0
(c) Robin Eggenkamp, 2016
-----------------------------------------------------------------------------
Author: Robin Eggenkamp <robin@edubits.nl>
Description:
   Publishes the status of devices to a MQTT topic and is able
   to set values based on subscribed topics

   MQTTClient based on https://github.com/goodfield/zway-mqtt

 *****************************************************************************/


// ----------------------------------------------------------------------------
// --- Class definition, inheritance and setup
// ----------------------------------------------------------------------------

function MQTT (id, controller) {
    MQTT.super_.call(this, id, controller);
}

inherits(MQTT, BaseModule);

_module = MQTT;

// ----------------------------------------------------------------------------
// --- Module instance initialized
// ----------------------------------------------------------------------------

MQTT.prototype.init = function (config) {
    // Call superclass' init (this will process config argument and so on)
    MQTT.super_.prototype.init.call(this, config);

    var self = this;

	self.initMQTTClient();

	self.callback = _.bind(self.updateDevice, self);
	self.controller.devices.on("modify:metrics:level", self.callback);
};

MQTT.prototype.stop = function () {
	var self = this;

	self.controller.devices.off("modify:metrics:level", self.callback);

    MQTT.super_.prototype.stop.call(this);
};

// ----------------------------------------------------------------------------
// --- Module methods
// ----------------------------------------------------------------------------

MQTT.prototype.initMQTTClient = function () {
	var self = this;

	executeFile(self.moduleBasePath() + "/lib/buffer.js");
	executeFile(self.moduleBasePath() + "/lib/mqtt.js");

	var mqttOptions = {client_id: self.config.clientId};
	if (self.config.user != "none") {
		mqttOptions.username = self.config.user;
	}
	if (self.config.password != "none") {
		mqttOptions.password = self.config.password;
	}

	self.client  = new MQTTClient(self.config.host, parseInt(self.config.port), mqttOptions);

	self.client.connect(function () {
		self.log("Connected to " + self.config.host);

		self.client.subscribe(self.createTopic("/#"), {}, function (topic, payload) {
			var topic = topic.toString();

			if (!topic.endsWith(self.config.topicPostfixStatus) && !topic.endsWith(self.config.topicPostfixSet)) {
				return;
			}

			self.controller.devices.each(function (device) {
				self.processPublicationsForDevice(device, function (device, publication) {
					var deviceTopic = self.createTopic(publication.topic, device);

					if (topic == deviceTopic + "/" + self.config.topicPostfixStatus) {
						self.updateDevice(device);
					}

					if (topic == deviceTopic + "/" + self.config.topicPostfixSet) {
						var deviceType = device.get('deviceType');

						if (deviceType.startsWith("sensor")) {
							self.error("Can't perform action on sensor " + device.get("metrics:title"));
							return;
						}

						if (deviceType === "switchMultilevel" && payload !== "on" && payload !== "off") {
							device.performCommand("exact", {level: payload + "%"});
						} else if (deviceType === "thermostat") {
							device.performCommand("exact", {level: payload});
						} else {
							device.performCommand(payload);
						}
					}
				});
			});
		});
	});

	self.client.onError(function (error) {
		self.error(error.toString());
	});

	self.client.onDisconnect(function () {
		self.error("Disconnected, will retry to connect...");
		self.client.reconnect();
	});
};

MQTT.prototype.updateDevice = function (device) {
	var self = this;

	var value = device.get("metrics:level");

	if (device.get("deviceType") == "switchBinary" || device.get("deviceType") == "sensorBinary") {
		if (value == 0) {
			value = "off";
		} else if (value == 255) {
			value = "on";
		}
	}

	self.processPublicationsForDevice(device, function (device, publication) {
		var topic = self.createTopic(publication.topic, device);

		self.publish(topic, value, publication.retained);
	});
};

MQTT.prototype.processPublicationsForDevice = function (device, callback) {
	var self = this;

	if (! _.isFunction(callback)) {
		self.error('Invalid callback for processPublicationsForDevice');
		return;
	}

	_.each(self.config.publications, function (publication) {
		switch (publication.type) {
			case "tag":
				if (_.intersection(publication.tags, device.get("tags")).length > 0) {
					callback(device, publication);
				}
				break;
			case "single":
				if (publication.deviceId == device.id) {
					callback(device, publication);
				}
				break;
		}
	});
};

MQTT.prototype.publish = function (topic, value, retained) {
	var self = this;

	if (self.client && self.client.connected) {
		var options = {};
		options.retain = retained;

		self.client.publish(topic, value.toString().trim(), options);
	}
};

MQTT.prototype.createTopic = function (pattern, device) {
	var self = this;

	var topicParts = [].concat(self.config.topicPrefix.split("/"))
		.concat(pattern.split("/"));

	if (device != undefined) {
		topicParts = topicParts.map(function (part) {
			return part.replace("%roomName%", self.findRoom(device.get("location")).title.toCamelCase())
					   .replace("%deviceName%", device.get("metrics:title").toCamelCase());

			return part;
		});
	}

	return topicParts.filter(function (part) {
		return part !== undefined && part.length > 0;
	}).join("/");
};

MQTT.prototype.findRoom = function (roomId) {
	var self = this;

	var locations = self.controller.locations;
	if (locations) {
		return locations.filter(function (location) {
			return location.id == roomId;
		})[0];
	}
	return undefined;
};

// ----------------------------------------------------------------------------
// --- Utility methods
// ----------------------------------------------------------------------------

String.prototype.toCamelCase = function() {
	return this
		.replace(/\s(.)/g, function($1) { return $1.toUpperCase(); })
		.replace(/\s/g, '')
		.replace(/^(.)/, function($1) { return $1.toLowerCase(); });
};

String.prototype.startsWith = function (s) {
	return this.length >= s.length && this.substr(0, s.length) == s;
};

String.prototype.endsWith = function (s) {
	return this.length >= s.length && this.substr(this.length - s.length) == s;
};

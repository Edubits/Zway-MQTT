# MQTT Z-Way HA module

Publishes the status of devices to a MQTT topic and is able to set
values based on subscribed topics.

It is possible to publish the status for single devices, or for devices
which are tagged. Per publication you can customize the topic and decide
if the message should be retained or not.

# Installation

Make sure that the [BaseModule](https://github.com/maros/Zway-BaseModule) is installed prior to installing this 
module.

The preferred way of installing this module is via the "Zwave.me App Store"
available in 2.2.0 and higher. For stable module releases no access token is 
required. If you want to test the latest pre-releases use 'mqtt_beta' as 
app store access token.

For developers and users of older Z-Way versions installation via Git is 
recommended.

```shell
cd /opt/z-way-server/automation/userModules
git clone https://github.com/Edubits/Zway-MQTT.git MQTT --branch latest
```

To update or install a specific version
```shell
cd /opt/z-way-server/automation/userModules/MQTT
git fetch --tags
# For latest released version
git checkout tags/latest
# For a specific version
git checkout tags/1.0
# For development version
git checkout -b master --track origin/master
```

# Usage

Add an instance of the app through and fill in the details about your
MQTT broker. After this configure for which devices you want to publish
the status to MQTT. You can either configure this for a single device
or for all devices tagged with a certain tag at once.

## Defining the publication topic

You can define the topic used for publication. It's constructed from the
following parts:

* Topic Prefix – The start of each topic
* Topic – Per publication defined topic

In each of these you can use `%deviceName` and `%roomName%` as variables.
For example having `Foo/bar` as prefix and `%roomName%/%deviceName` as 
topic can result in a message published on the topic 
`Foo/bar/livingRoom/dimmer`. Both `%deviceName` and `%roomName%` will be
camelcased.

## Interacting through MQTT

You can also publish to certain topics to interact with Z-Way. For this
the two postfixes are used:

* Status postfix (default: status)
* Set postfix (default: set)

Taking the same example as before, when you publish an empty message to 
`Foo/bar/livingRoom/dimmer/status` the current value will be published
again. When you publish a value (for example `on`, `off` or `87`) to 
`Foo/bar/livingRoom/dimmer/set` the dimmer will be set to that level.

# Acknowledgements

I want to thank @goodfield for finding and fixing a fully JavaScript
MQTTClient which I could use in this module as well. His module can be
found at https://github.com/goodfield/zway-mqtt.
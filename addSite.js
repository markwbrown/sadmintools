#!/usr/bin/env iojs
"use strict";

var exec = require('child_process').exec;
var readline = require('readline');
var ncp = require('ncp');
var fs = require('fs');
var client = new(require('linode-api').LinodeClient)('clientkey');

var SERVER_V4 = 'ipaddress';
var SERVER_V6 = 'ipaddress';

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

var args = process.argv.slice(2);

var config_location = "/etc/nginx/sites-enabled/";

function createRecords(cb) {
  if(containsSubdomain(config['domain'])) return console.log("Skipping DNS record creation (this is a subdomain)");

  client.call('domain.create', {
    'Domain': config.domain,
    'Type': 'master',
    'SOA_Email': 'soa@email.com'
  }, function (err, res) {
    if(err) return console.log("Error creating new domain:", err);
    let DOMAINID = res.DomainID;

    var record = {
      'DomainID':DOMAINID,
      'Type': 'A',
      'Name': '',
      'Target': SERVER_V4
    };
    var recordv6 = {
      'DomainID':DOMAINID,
      'Type': 'AAAA',
      'Name': '',
      'Target': SERVER_V6
    };

    client.call('domain.resource.create', record, function (err, res) {
      if(err) return console.log("Error creating new record:", err);
    });

    var record_wc = record;
    record_wc.Name = '*';

    client.call('domain.resource.create', record_wc, function (err, res) {
      if(err) return console.log("Error creating new record:", err);
    });

    if(config['ipv6']) {
      client.call('domain.resource.create', recordv6, function (err, res) {
        if(err) return console.log("Error creating new record:", err);
      });

      var recordv6_wc = recordv6;
      recordv6_wc.Name = '*';

      client.call('domain.resource.create', recordv6_wc, function (err, res) {
      if(err) return console.log("Error creating new record:", err);
    });
    }
  });
}

var config = {};

// These options are ordered in a particular way so that it's harder for the user to
// set conflicting options.
var config_options = [
  {
    name: "domain",
    default: null,
    prompt: "FQDN (domain name)",
    type: "string"
  },
  {
    name: "allow_www",
    default: true,
    prompt: "Allow www.? [Y/N] Default=Y",
    type: "bool"
  },
  {
    name: "wordpress",
    default: false,
    prompt: "Wordpress Site? [Y/N] Default=N",
    type: "bool"
  }
];

function showPrompt(option) {
  rl.question(option.prompt + ": ", function(answer) {
    let ans = answer.toLowerCase();
    if(option.type === "bool") {
      if(ans === 'y') {
        config[option.name] = true;
      } else if(ans === 'n') {
        config[option.name] = false;
      } else {
        config[option.name] = option.default;
      }
    } else if(option.type === "string") {
      if(ans == '') {
        console.log("Error: Domain cannot be blank.");
        process.exit(1);
      } else {
        config[option.name] = ans;
      }
    }
    promptGenerator.next();
  });
}

function* createPrompt() {
  for(let option of config_options) {
    yield showPrompt(option);
  }
  return checkConfig();
}

var promptGenerator = createPrompt();

function containsSubdomain(domain) {
  var regex = new RegExp(/^([a-z]+\:\/{2})?([\w-]+\.[\w-]+\.\w+)$/);

  if(domain.match(regex)) return true;
  else return false;
}

function validateConfig(settings) {
  if(settings['domain'] == null) {
    console.log("Error: The domain was blank.");
    return false;
  } else if(settings['domain'].substring(0,3) === "www") {
    console.log("Error: Please do not include 'www.' as part of the domain name, it is a special case and must be configured differently.");
    return false;
  }

  else return true;
}

var blocks = {
  listen: function() {
    var string = "listen 80;";
    string += "\n  listen [::]:80;";
    return string;
  },
  force_www: function() {
    return `server {
  ${this.listen()}
  server_name ${config.domain};
  return 301 $scheme://www.${config.domain}$request_uri;
}\n`;
  },
  root: function() {
    return `root /var/www/${config.domain}/dist;`;
  },
  server_name: function() {
    var string = 'server_name';
    if(!config['force_www']) {
      string += ` ${config.domain}`;
    }
    if(config['allow_www'] && !containsSubdomain(config['domain'])) {
      string += ` www.${config.domain}`;
    }
    string += ';';
    return string;
  },
  strip_www: function() {
    return `server {
  ${this.listen()}
  server_name www.${config.domain};
  return 301 $scheme://${config.domain}$request_uri;
}\n`;
  }
};

function generateConfig() {
  var string = '';

  if(!config['allow_www'] && !containsSubdomain(config['domain'])) {
    string += blocks.strip_www();
  }

  string += "server {\n"
  string += "  " + blocks.listen() + '\n\n';
  string += "  " + blocks.server_name() + '\n\n';
  string += "  " + blocks.root() + '\n\n';

  string += "  include snippets/generic_server_block.conf;\n";

  if(config['wordpress']) {
    string += "  include snippets/wordpress.conf;\n";
  }

  string += "  include snippets/php-block.conf;\n";

  string += "}\n"
  return string;
}

function writeConfig(file_contents) {
  console.log("Writing configuration to: " + config_location + config.domain);
  try {
    fs.writeFile(config_location + config.domain, file_contents);
  } catch(e) {
    console.log(e);
    process.exit(1);
  }
  console.log("Creating webroot at: /var/www/" + config.domain);
  ncp(__dirname+'/default/', '/var/www/' + config.domain, function (err) {
    if(err) {
      console.log("Error: Couldn't copy the default website at ("+__dirname+"/default).");
      return process.exit(1);
    }
    else {
      console.log("Restarting nginx...");
      exec('nginx -s reload', function(err, out) {
        if(err instanceof Error) {
          throw err;
          process.stderr.write(err);
          return process.exit(1);
        }
        process.stdout.write(out);

        console.log("Creating DNS records...");
        createRecords();
      });
    }
  });
}

promptGenerator.next();

function checkConfig() {
  if(validateConfig(config) === true) {
    var file = generateConfig();
    console.log('\n\n'+file+'\n');
    rl.question("Does this configuration look correct? [Y/N]: ", function(answer) {
      let ans = answer.toLowerCase();
      if(ans === 'y') {
        writeConfig(file);
      } else  {
        console.log("Domain configuration discarded.");
        process.exit(1);
      }
      rl.close();
    });
  } else {
    process.exit(1);
  }
}
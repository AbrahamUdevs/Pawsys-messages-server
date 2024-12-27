const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const sequelize = require('./db');
const app = express();
const axios = require('axios');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const jwt = require("jsonwebtoken");
const WebSocket = require('ws');
dotenv.config();

app.use(express.json());

app.use(express.urlencoded({ extended: false }));

app.use(express.static('public'));

var conn = new WebSocket(`ws://${process.env.PAWSY_WEBSOCKET_SERVER}`);

function connect_websocket() {
  conn.onopen = function(e) {
    console.log('Conexión exitosa con el websocket.');
  }
}

connect_websocket();

sequelize.authenticate()
  .then(() => {
    console.log('Conexión exitosa a la base de datos.');
  })
  .catch((err) => {
    console.error('No se pudo conectar a la base de datos:', err);
  });

  mongoose.connect(`mongodb://${process.env.MONGOOSE_HOST}/${process.env.MONGOOSE_DB}`, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  
  mongoose.connection.once('open', () => {
    console.log('Conectado a MongoDB');
  }).on('error', (error) => {
    console.log('Error de conexión a MongoDB:', error);
  });


app.get('/user-information', async function (req, res) {
  try{
    const urlAPI = `https://graph.facebook.com/${req.query.user}?access_token=${req.query.access_token}`;
    
    const msgResp = await axios.get(urlAPI);

    res.send({ "status" : true, "data": msgResp.data });
  }
  catch (error){
    res.send({ "status" : false, "error": error });
  }
});

app.get('/get-conversations', async function (req, res) {

  try {
    const colConversation = mongoose.connection.collection('conversations');

    let conResp = await colConversation.findOne({ channelId: req.query.channelId });

    let convers = [];
    if(conResp == null){
      conResp = [];
    }
    else {
      const senders = mongoose.connection.collection('senders');

      const conversations = conResp.conversations;

      for (let i = 0; i < conversations.length; i++) {
      
        let newConver = {};
        let snd = await senders.findOne({ id: conversations[i].sender, platform: conversations[i].platform });

        profile = {};

        if (snd != null) {
          profile.name = snd.name;
          profile.image = snd.image;
        }

        const lastMessage = conversations[i].messages.reduce((max, obj) => {
          return obj.time > max.time ? obj : max;
        }, conversations[i].messages[0]);

        newConver = {
          platform: conversations[i].platform,
          sender: conversations[i].sender,
          updated: conversations[i].updated,
          profile: profile,
          unseen: conversations[i].messages.filter(m => m.seen === 0).length,
          lastMessage: {
            type: lastMessage.type,
            text: lastMessage.type == "text" ? lastMessage.text : "[Imagen]",
            file: lastMessage.file
          },
        };

        convers.push(newConver);
      };
    }
    
    convers.sort((a, b) => new Date(b.updated) - new Date(a.updated));

    console.log(convers);

    res.send({ "status" : true, "data": convers });
  }
  catch (error){
    
    console.log("Fallo");

    res.send({ "status" : false, "error": error });
  }
});

app.get('/count-unseen-messages', async function (req, res) {
  
  try {
    const colConversation = mongoose.connection.collection('conversations');

    let channelConversation = await colConversation.findOne({ channelId: req.query.channelId });

    let totalMessages = 0;
    channelConversation.conversations.forEach(conv => {
      totalMessages += conv.messages.filter(m => m.seen === 0).length;
    });

    res.send({ "status" : true, "data": totalMessages });
  } catch (error) {
    console.log(error);
    res.send({ "status" : false, "error": error });
  }
});

app.get('/get-single-conversation', async function (req, res) {

  try {
    const colConversation = mongoose.connection.collection('conversations');

    let channelConversation = await colConversation.findOne({ channelId: req.query.channelId, 'conversations.sender': req.query.sender, 'conversations.platform': req.query.platform }, { 'conversations.$': 1 });
  
    const conversation = channelConversation.conversations.filter(conv => conv.platform == req.query.platform && conv.sender == req.query.sender);

    let messages = conversation[0].messages;
    
    messages.sort((a, b) => new Date(a.time) - new Date(b.time));
    
    const updated_conversation = await seen_messages(req.query.channelId, req.query.sender, req.query.platform);

    res.send({ "status" : true, "data": messages });
  }
  catch (error){
    console.log(error);
    res.send({ "status" : false, "error": error });
  }

});

app.post('/seen-messages', async function (req, res) {

  try {
    
    const updated_conversation = await seen_messages(req.body.channelId, req.body.sender, req.body.platform);

    if (updated_conversation.status) {
      res.send({ "status" : true, "data": updated_conversation.dataRes });
    }
    else {
      res.send({ "status" : false, "error": updated_conversation.err });
    }
  }
  catch (error){
    console.log(error);
    res.send({ "status" : false, "error": error });
  }

});

async function get_user_information(user, channelId, platform) {
  
  try {
    const [channel, metadatos] = await sequelize.query('SELECT * FROM channel WHERE id = :id', {
      replacements: { id: channelId },
      type: sequelize.QueryTypes.SELECT
    });

    const ominchannelData = JSON.parse(channel[`omnichannel_${platform}`]);

    let platformName = "";
    switch (platform) {
      case "f":
        platformName = "facebook";
        break;
    
      case "i":
        platformName = "instagram";
        break;
    }
    
    const urlAPI = `https://graph.${platformName}.com/${user}?access_token=${ominchannelData.access_token}`;
      
    const msgResp = await axios.get(urlAPI);

    const data = msgResp.error == undefined ? msgResp.data : null;

    return data;
  } catch (error) {
    return null;
  }
}

app.post("/webhook-meta/:channelId/:platform", async (req, res) => {

  // console.log(req.body.entry?.[0]?.changes[0].value.contacts?.[0].profile.name);
  // console.log(req.body.entry?.[0].messaging?.[0].message.attachments?.[0].payload.url);

  let platform = req.params.platform;
  let type = "";

  let is_echo = false;

  switch (platform) {
    case "w":
      type = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0].type;
      break;
  
    default:
      type = "text";

      if (req.body.entry?.[0].messaging?.[0].message.text == undefined) {
        type = req.body.entry?.[0].messaging?.[0].message.attachments?.[0].type;
      }

      if(req.body.entry?.[0].messaging?.[0].message.is_echo != undefined){
        is_echo = true;
      }
      break;
  }
  
  let message_body = "";
  let time = "";
  let sender = "";
  let file = "";
  let senderName = "";
  let senderImage = "";

  if ((type == "text" || type == "image") && !is_echo) {

    const uuid = uuidv4();

    switch (platform) {
      case "w":
        let valueW = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];
        sender = valueW.from;
        switch (type) {
          case "text":
            message_body = valueW.text.body;
            break;
          case "image":
            let imageId = valueW.image.id;
            file = await get_image_url(imageId, req.params.channelId, uuid, sender);
            break;
        }
        time = (valueW.timestamp * 1000).toString();
        senderName = req.body.entry?.[0]?.changes[0].value.contacts?.[0].profile.name;
        senderImage = `${process.env.PAWSY_SERVER}/img/avatar/avatar.png`;
        break;
    
      default:
        let value = req.body.entry?.[0].messaging?.[0];
        switch (type) {
          case "text":
            message_body = value.message.text;
            break;
          case "image":
            file = value.message.attachments?.[0].payload.url;
            break;
        }
        time = (value.timestamp).toString();
        sender = value.sender.id;
        senderInfo = await get_user_information(sender, req.params.channelId, req.params.platform);

        if(senderInfo != null){
          switch (req.params.platform) {
            case "f":
              senderName = senderInfo.first_name + " " + senderInfo.last_name;
              break;
            case "i":
              senderName = senderInfo.username;
              break;
          }
          senderImage = senderInfo.profile_pic;
        }
        else{
          let errorPlatform = req.params.platform == "f" ? "Facebook" : "Instagram";
          senderName = errorPlatform +" user "+sender;
          senderImage = `${process.env.PAWSY_SERVER}/img/avatar/avatar.png`;
        }
        break;
    }

    const message = {
      platform: platform,
      msg: message_body,
      file: file,
      type: type,
      time: time,
      sender: sender,
      senderName: senderName,
      senderImage: senderImage,
    }
    
    try{
        const dateUtc = new Date(time * 1000);
        
        const options = {
          timeZone: 'America/Guatemala',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        };
        
        const dateInGmtMinus6 = new Intl.DateTimeFormat('es-CR', options).format(dateUtc);
      
        let completed = false;
        while (!completed) {
          try {
            conn.send(JSON.stringify({ "type": "message", "message_type":type, "message": message, "time":dateInGmtMinus6, "channelId": req.params.channelId}));
            completed = true;
          } catch (error) {
            connect_websocket();
          }
        }

        console.log(message);
        update_conversation(req.params.channelId, message, "c", uuid);
    }
    catch(error){
      console.log("Error");
    }
  }

  res.sendStatus(200);
});

app.post("/webhook-meta-message-response", async function (req, res) {
  
  const data = req.body;

  try {

    const uuid = uuidv4();

    switch (data.platform) {
      case "w":
        const config = { headers: { 'Authorization': `Bearer ${data.access_token}`, 'Content-Type': `application/json` } };
        const url = `https://graph.facebook.com/v21.0/${data.id}/messages`;
        const body = {
          "messaging_product": "whatsapp",
          "recipient_type": "individual",
          "to": data.sender,
          "type": "text",
          "text": {
            "preview_url": true,
            "body": data.msg
          }
        };
        const respW = await axios.post(url, body, config);
        break;
    
      case "f":
        const page = await get_page_access(data.user, data.id, data.access_token);

        const urlF = `https://graph.facebook.com/v21.0/${data.id}/messages?recipient={'id':'${data.sender}'}&messaging_type=RESPONSE&message={'text':'${data.msg}'}&access_token=${page.access_token}&platform=MESSENGER`;

        const respF = await axios.post(urlF);
        break;
      
      case "i":
        const urlI = `https://graph.instagram.com/v21.0/${data.id}/messages?access_token=${data.access_token}`;

        const iBody = { recipient: { "id" : data.sender }, message : {'text' : data.msg }};

        const respI = await axios.post(urlI, iBody);
        console.log(1);
        break;
    }

    const message = {
      platform: data.platform,
      msg: data.msg,
      file: "",
      type: data.type,
      time: Date.now().toString(),
      sender: data.sender
    }

    console.log(message);

    update_conversation(data.channelId, message, "o", uuid);
    res.sendStatus(200);
  }
  catch (error) {
    console.log(error);
  }
});

async function update_conversation(channelId, message, user, uuid) {
  
  const colSender = mongoose.connection.collection('senders');
  let sender = await colSender.findOne({ id: message.sender, platform: message.platform });
  if (sender == null) {
    sender = await create_sender(message.sender, message.platform);
  }

  if (user != "o") {
    const resultUpdateSender = await colSender.updateOne({ _id: sender._id }, { $set: { name: message.senderName, image: message.senderImage } });
  }

  const colConversation = mongoose.connection.collection('conversations');

  let channel = await colConversation.findOne({ channelId: channelId });
  if (channel == null) {
    channel = await create_channel_conversation(channelId);
  }

  let channelConversation = await colConversation.findOne({ channelId: channelId, 'conversations.sender': message.sender, 'conversations.platform': message.platform }, { 'conversations.$': 1 });
  if (channelConversation == null) {
    channelConversation = await create_channel_conversation_sender(channelId, message);
  }

  const newMessage = {
    id: uuid,
    user: user,
    text: message.msg,
    file: message.file,
    type: message.type,
    time: message.time,
    seen: user == "o" ? 1 : 0
  }

  const conversationUpdated = await colConversation.updateOne({ channelId: channelId, 'conversations.sender': message.sender }, { $push: { "conversations.$.messages": newMessage }, $set: { "conversations.$.updated": Date.now() } });
  
  console.log("Conversación actualizada");
}

app.get("/webhook-meta/:channelId/:platform", async (req, res) => {

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const [channel, metadatos] = await sequelize.query('SELECT * FROM channel WHERE id = :id', {
    replacements: { id: req.params.channelId },
    type: sequelize.QueryTypes.SELECT
  });

  const data = JSON.parse(channel[`omnichannel_${req.params.platform}`]);

  if (mode === "subscribe" && token === data.webhook_token) {
    res.status(200).send(challenge);
    console.log("Webhook verified successfully!");
  } else {
    res.sendStatus(403);
  }
});

async function seen_messages(channelId, sender, platform) {
  try {
    const colConversation = mongoose.connection.collection('conversations');

    const updated_conversation = await colConversation.updateMany({
        channelId: channelId,
        'conversations.sender': sender,
        'conversations.platform': platform
      },
      {
        $set: { 'conversations.$.messages.$[elem].seen': 1 }
      },
      {
        arrayFilters: [{ 'elem.seen': 0 }]
    });

  return { status: true, dataRes: "Yes" }
  } catch (error) {
    return { status: false, err: error }
  }
}

async function create_sender(senderId, platform) {
  const collection = mongoose.connection.collection('senders');

  const sender = {
    id: senderId,
    platform: platform,
    name: "",
    image: ""
  };

  const createdSender = await collection.insertOne(sender);

  const resultSender = await collection.findOne({ _id: createdSender.insertedId });

  return resultSender;
}

async function create_channel_conversation(channelId) {

  const collection = mongoose.connection.collection('conversations');

  const newChannel = {
    channelId: channelId,
    conversations: []
  };

  const createdChannel = await collection.insertOne(newChannel);

  const resultChannel = await collection.findOne({ _id: createdChannel.insertedId });

  return resultChannel;
}

async function create_channel_conversation_sender(channelId, message) {

  const collection = mongoose.connection.collection('conversations');

  const newConversation = {
    platform: message.platform,
    sender: message.sender,
    updated: 0,
    messages: []
  };

  const createdConversation = await collection.updateOne({ channelId: channelId }, { $push: { conversations: newConversation } });

  const channelConversations = await collection.findOne({ channelId: channelId, 'conversations.sender': message.sender }, { 'conversations.$': 1 });

  return channelConversations;
}

async function get_page_access(user, pageId, access_token) {
    const accounts = await axios.get(`https://graph.facebook.com/${user}/accounts?access_token=${access_token}`);

    let page = null;
    accounts.data.data.forEach(item => {
      if(item.id == pageId){
          page = item;
      }
    });

    console.log(page)

    return page;
};

async function getMessagesTranslation(item, access_token) {
    const urlMessageApi = `https://graph.facebook.com/v21.0/${item.id}?fields=id,created_time,from,to,message&access_token=${access_token}`;
    const response = await fetch(urlMessageApi);
    const data = await response.json();

    const fecha = new Date(data.created_time);
    const offsetCostaRica = 6 * 60;

    fecha.setMinutes(fecha.getMinutes() + offsetCostaRica - fecha.getTimezoneOffset());
    
    const anio = fecha.getFullYear();
    const mes = (fecha.getMonth() + 1).toString().padStart(2, '0');
    const dia = fecha.getDate().toString().padStart(2, '0');
    const horas = fecha.getHours().toString().padStart(2, '0');
    const minutos = fecha.getMinutes().toString().padStart(2, '0');
    const segundos = fecha.getSeconds().toString().padStart(2, '0');
    const offset = '-0600';
    
    data.created_time = `${anio}-${mes}-${dia}T${horas}:${minutos}:${segundos}${offset}`;

    return data;
  }

async function get_image_url(media_id, channelId, uuid, sender) {
  
  let result = "";

  try{
    const [channel, metadatos] = await sequelize.query('SELECT * FROM channel WHERE id = :id', {
      replacements: { id: channelId },
      type: sequelize.QueryTypes.SELECT
    });

    const data = JSON.parse(channel["omnichannel_w"]);

    const token = data.access_token;
    
    let config = {
      headers: {
        'Authorization': 'Bearer ' + token
      }
    }
    
    const resp = await axios.get(`https://graph.facebook.com/v21.0/${media_id}`, config);

    let url = resp.data.url;

    const respFinal = await axios.get(url, { responseType: 'stream', headers: { 'Authorization': 'Bearer ' + token } });

    try {
      if (!fs.existsSync(`./public/w-images/${channelId}/${sender}`)){
        fs.mkdirSync(`./public/w-images/${channelId}/${sender}`, { recursive: true });
      }
      console.log('La carpeta ha sido creada');
    } catch (error) {
        console.error('Error al crear la carpeta:', error);
    }

    const writer = fs.createWriteStream(`./public/w-images/${channelId}/${sender}/${uuid}.jpg`);

    await new Promise((resolve, reject) => {
      respFinal.data.pipe(writer);

      writer.on('finish', resolve);

      writer.on('error', reject);
    });
  }
  catch(err){
    console.log(err);
  }
  return uuid+".jpg";
}

app.listen(process.env.PORT, () => {
    console.log(`Server is running on http://localhost:${process.env.PORT}`);
  });  
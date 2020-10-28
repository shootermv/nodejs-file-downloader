const fs = require('fs');
const axios = require('axios');
const stream = require('stream');
const { Transform } = require('stream')
const util = require('util');
const FileProcessor = require('./utils/FileProcessor');
const pipeline = util.promisify(stream.pipeline);
const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const { deduceFileName } = require('./utils/fileName');
const rpur = require('./utils/rpur');
const unlink = util.promisify(fs.unlink)
const rename = util.promisify(fs.rename)


const configTypes = {
  url: {
    type: 'string',
    mandatory: true
  },
  directory: {
    type: 'string',
    mandatory: false
  },
  fileName: {
    type: 'string',
    mandatory: false
  },
  cloneFiles: {
    type: 'boolean',
    mandatory: false
  }
};

const validateConfig = (config) => {
  const generateTypeError = (prop) => { throw new Error(`config.${prop} must be of type ${configTypes[prop].type}`) }
  for (let prop in configTypes) {
    if (configTypes[prop].mandatory) {
      if (!config[prop])
        throw new Error(`Must supply a config.${prop}`);

      if (typeof config[prop] !== configTypes[prop].type)
        generateTypeError(prop)
    }
    if (config.hasOwnProperty(prop) && typeof config[prop] !== configTypes[prop].type)
      generateTypeError(prop)
  }
}


module.exports = class Downloader {


  /**
   * 
   * @param {object} config 
   * @param {string} config.url 
   * @param {string} [config.directory]    
   * @param {string} [config.fileName = undefined] 
   * @param {boolean} [config.cloneFiles=true] 
   * @param {number} [config.timeout=6000] 
   * @param {number} [config.maxAttempts=1] 
   * @param {object} [config.headers = undefined] 
   * @param {object} [config.httpsAgent = undefined] 
   * @param {function} [config.onError = undefined] 
   * @param {function} [config.onResponse = undefined] 
   * @param {function} [config.onProgress = undefined] 
   * @param {boolean} [config.shouldBufferResponse = false] 
   * @param {boolean} [config.useSynchronousMode = false] 
   */
  constructor(config) {
    // super();
    if (!config || typeof config !== 'object') {
      throw new Error('Must provide a valid config object')
    }
    validateConfig(config);

    const defaultConfig = {
      directory: './',
      fileName: undefined,
      timeout: 6000,
      maxAttempts: 1,
      useSynchronousMode: false,
      httpsAgent: undefined,
      headers: undefined,
      cloneFiles: true,
      shouldBufferResponse: false,
      onResponse: undefined,
      onError: undefined,
      onProgress: undefined
    }

    this.config = {
      ...defaultConfig,
      ...config
    }

    if (this.config.filename) {
      this.config.fileName = this.config.filename
    }

    this.response = null;
    this.readStream = null;
    this.fileSize = null;
    this.currentDataSize = 0;


  }

  //For EventEmitter backwards compatibility
  on(event, callback) {
    this.config[`on${capitalize(event)}`] = callback
  }


   /**
   * @return {Promise<void>}
   */
  async download() {

    await this._makeUntilSuccessful(async () => {
      const response = await this._request();
      if (this.config.onResponse) {
        const shouldContinue = await this.config.onResponse(response);
        if(shouldContinue === false){
          return;
        }
      }
      await this._save()
    })

  }
 

  /**
   * @return {Promise<axios.AxiosResponse>}
   */
  async _request() {
    const response = await this._makeRequest();
    // const response = await this._makeRequestUntilSuccessful();
    // const response = await this._makeUntilSuccessful(this._makeRequest);
    this.response = response;
    
    const contentLength = response.headers['content-length'] || response.headers['Content-Length'];
    this.fileSize = parseInt(contentLength);
    return response;

  }

  /**
   * @return {Promise<void>}
   */
  async _save() {
    const finalFileName = await this._getFinalFileName();
    if (this.config.shouldBufferResponse) {
      // debugger;
      return this._saveFromBuffer(this.response.data,finalFileName);
      // return this._makeUntilSuccessful(async()=>{await this._saveFromBuffer(this.response.data)});
    }
    // debugger;
    await this._saveFromReadableStream(this.response.data,finalFileName);
    // await this._makeUntilSuccessful(async()=>{await this._saveFromReadableStream(this.response.data)});
  }


 

  /**
   * @param {Function} asyncFunc
   * @return {Promise<any>} 
   */
  async _makeUntilSuccessful(asyncFunc) {

    let data;
    // debugger;
    const func = asyncFunc.bind(this)
    await rpur(async () => {

      data = await func();
    }, {
      onError: async (e) => {
        if (this.config.onError) {
          await this.config.onError(e);
        }
      },
      maxAttempts: this.config.maxAttempts
    })
    return data;


  }
  /**
   * 
   * @return {Promise<axios.AxiosResponse>}
   */
  async _makeRequest() {
    // debugger;
    const shouldBuffer = this.config.shouldBufferResponse
    const httpsAgent = this.config.httpsAgent;
    const response = await axios({
      method: 'get',
      url: this.config.url,
      timeout: this.config.timeout,
      headers: this.config.headers,
      httpsAgent,
      responseType: shouldBuffer ? 'arraybuffer' : 'stream'
    })


    return response;
  }



  _createWriteStream(fullPath) {
    return fs.createWriteStream(fullPath)
  }


  _getProgressStream() {
    const that = this;
    const progress = new Transform({

      transform(chunk, encoding, callback) {

        that.currentDataSize += chunk.byteLength;

        that.percentage = ((that.currentDataSize / that.fileSize) * 100).toFixed(2)

        if (that.config.onProgress) {
          that.config.onProgress(that.percentage, chunk);
        }

        // Push the data onto the readable queue.
        callback(null, chunk);
      }
    });

    return progress;

  }

 




  async _saveFromReadableStream(read,fileName) {

    const progress = this._getProgressStream();
    const finalPath = `${this.config.directory}/${fileName}`
    const tempPath = this._getTempFilePath(finalPath);
    const write = this._createWriteStream(tempPath)
    // const write = this._createWriteStream(`${this.config.directory}/${fileName}`)
    try {
      debugger;
      await pipeline(read, progress, write)
      debugger;
      await this._renameTempFileToFinalName(tempPath,finalPath)
    } catch (error) {
      await this._removeFailedFile(tempPath)
      throw error
    }
    

  }

  async _saveFromBuffer(buffer,fileName) {

    const finalPath = `${this.config.directory}/${fileName}`
    const tempPath = this._getTempFilePath(finalPath);
    await writeFile(tempPath, buffer)
    await this._renameTempFileToFinalName(tempPath,finalPath)

  }

  async _removeFailedFile(path){
    try {
       await unlink(path);
    } catch (error) {
      
    }
   
  }

  async _renameTempFileToFinalName(temp,final){
    debugger;
    try {
      await rename(temp,final)
    } catch (error) {
      
    }
    
    // await unlink(path);

  }

  _getTempFilePath(path){
    return `${path}.download`;
  }



  async _getFinalFileName() {
    let fileName;
    if (this.config.fileName) {
      fileName = this.config.fileName
    } else {
      fileName = deduceFileName(this.config.url, this.response.headers)
    }
    // debugger;
    var fileProcessor = new FileProcessor({ useSynchronousMode: this.config.useSynchronousMode, fileName, path: this.config.directory })
    // debugger;
    // if (! await fileProcessor.pathExists(this.config.directory)) {
    if (!await fileProcessor.pathExists(this.config.directory)) {
      // debugger;
      try {
        await mkdir(this.config.directory, { recursive: true });
      } catch (error) {
        // debugger;
      }

    }
    if (this.config.cloneFiles) {


      // debugger;
      fileName = await fileProcessor.getAvailableFileName()
      // fileName = fileProcessor.getAvailableFileName()
    }

    return fileName;
  }


}


const capitalize = (s) => {
  if (typeof s !== 'string') return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}
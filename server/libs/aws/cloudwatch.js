/*eslint no-console: ["error", { allow: ["log"] }] */
import mongo from '../../libs/mongo'
import { ObjectID } from 'mongodb'
import mapValuesLimit from 'async/mapValuesLimit'
import config from '../../config'
import moment from 'moment'

let c = mongo.collections

/**
 * Setup the event rule for passing events to SQS
 */
const initEventRule = (eventSdk, ruleName) => {
  const batchQueue = config.aws.batch.queue
  const awsRegion = config.aws.credentials.region
  const awsAccount = config.aws.credentials.accountId
  const jobQueueARN = `arn:aws:batch:${awsRegion}:${awsAccount}:job-queue/${batchQueue}`
  const rulePattern = `{
    "detail-type": [
      "Batch Job State Change"
    ],
    "source": [
      "aws.batch"
    ],
    "detail": {
      "jobQueue": [
        "${jobQueueARN}"
      ]
    }
  }
  `
  // The rule is fairly simple, push any events to an SQS queue with the same name
  const rule = {
    Name: ruleName,
    Description: `Auto-generated rule for queue ${batchQueue}`,
    EventPattern: rulePattern,
    State: 'ENABLED',
  }
  return eventSdk.putRule(rule).promise()
}

/**
 * Init SQS queue to receive events
 */
const initSQSQueue = (SQS, sqsQueueName) => {
  const { accountId, region } = config.aws.credentials
  const policy = {
    Version: '2012-10-17',
    Id: `arn:aws:sqs:${region}:${accountId}:${sqsQueueName}/SQSDefaultPolicy`,
    Statement: [
      {
        Sid: `AWSEvents_batch-${sqsQueueName}_${sqsQueueName}`,
        Effect: 'Allow',
        Principal: {
          AWS: '*',
        },
        Action: 'sqs:SendMessage',
        Resource: `arn:aws:sqs:${region}:${accountId}:${sqsQueueName}`,
        Condition: {
          ArnEquals: {
            'aws:SourceArn': `arn:aws:events:${region}:${accountId}:rule/${sqsQueueName}`,
          },
        },
      },
    ],
  }

  const queueParam = {
    QueueName: sqsQueueName,
    Attributes: {
      VisibilityTimeout: '600',
      Policy: JSON.stringify(policy),
    },
  }
  return SQS.createQueue(queueParam).promise()
}

/**
     * Add a destination for the events produced by the rule
     */
const initRuleTarget = (eventSdk, ruleName) => {
  const awsRegion = config.aws.credentials.region
  const awsAccount = config.aws.credentials.accountId
  const sqsQueueArn = `arn:aws:sqs:${awsRegion}:${awsAccount}:${ruleName}`
  const target = {
    Rule: ruleName,
    Targets: [
      {
        Id: ruleName,
        Arn: sqsQueueArn,
      },
    ],
  }
  return eventSdk.putTargets(target).promise()
}

export default aws => {
  const cloudWatchLogs = new aws.CloudWatchLogs()
  const cloudWatchEvents = new aws.CloudWatchEvents()
  const SQS = new aws.SQS()

  return {
    sdk: cloudWatchLogs,
    events: cloudWatchEvents,

    /**
     * Setup all event related AWS prereqs
     */
    initEvents() {
      const batchQueue = config.aws.batch.queue
      const ruleName = `batch-events-${batchQueue}`
      return initEventRule(cloudWatchEvents, ruleName)
        .then(() => initSQSQueue(SQS, ruleName))
        .then(() => initRuleTarget(cloudWatchEvents, ruleName))
    },

    /**
     * Fetch logs based on a CloudWatch stream name
     * 
     * @param {string} logStreamName - CloudWatch stream to read
     * @param {boolean} truncate - limit results to 1000 lines
     * @param {function} callback - Callback each time logs are received 
     * 
     * @returns {Promise} - Resolves when all logs have been retrieved
     */
    getLogs(logStreamName, truncate, callback) {
      return new Promise((resolve, reject) => {
        this.getCloudwatchLogs(
          logStreamName,
          null,
          truncate,
          callback,
          resolve,
          reject,
        )
      })
    },

    /**
     * Get all logs given a logStreamName or continue from nextToken
     * callback(logs) is called each time logs are received
     */
    getCloudwatchLogs(
      logStreamName,
      nextToken = null,
      truncateFlag = false,
      callback,
      resolve,
      reject,
    ) {
      const params = {
        logGroupName: config.aws.cloudwatchlogs.logGroupName,
        logStreamName: logStreamName,
      }
      if (!truncateFlag) params.startFromHead = true
      if (nextToken) params.nextToken = nextToken
      if (truncateFlag) params.limit = 1000 // we only want the last 1000 lines of logs for view on client
      // cloudwatch log events requires knowing jobId and taskArn(s)
      // taskArns are available on job which we can access with a describeJobs call to batch
      this.sdk.getLogEvents(params, (err, data) => {
        if (err) {
          reject(err)
        }
        callback(data.events)
        //Cloudwatch returns a token even if there are no events. That is why checking events length
        if (data.events && data.events.length > 0 && data.nextForwardToken) {
          this.getCloudwatchLogs(
            logStreamName,
            data.nextForwardToken,
            truncateFlag,
            callback,
            resolve,
            reject,
          )
        } else {
          resolve()
        }
      })
    },

    /**
         * Given a jobId, get all logs for any subtasks and return useful
         * metadata along with the log lines
         */
    getLogsByJobId(jobId, callback) {
      c.crn.jobs.findOne({ _id: ObjectID(jobId) }, {}, (err, job) => {
        if (err) {
          callback(err)
        }
        let logStreamNames = job.analysis.logstreams || []
        let logStreams = logStreamNames.reduce((streams, ls) => {
          let stream = this.formatLegacyLogStream(
            ls,
            this.streamNameVersion(job),
          )
          streams[stream.name] = stream
          return streams
        }, {})
        mapValuesLimit(
          logStreams,
          10,
          (params, logStreamName, cb) => {
            this.getLogs(
              logStreamName,
              false,
              this._includeJobParams(params, cb),
            )
          },
          (err, logs) => {
            callback(err, logs)
          },
        )
      })
    },

    /**
         * Adapter for getLogs callback values to object with metadata
         */
    _includeJobParams(params, callback) {
      return (err, logs) => {
        let logsObj = { ...params, logs }
        callback(err, logsObj)
      }
    },

    /*
         * Return a version value for breaking Batch API changes to log stream names
         */
    streamNameVersion(job) {
      // The only way to determin which version a job uses is date started
      if (job.analysis.created < moment('2017-08-21T14:00-07:00')) {
        // The original stream name format
        // appDefName / jobId / ecsTaskId
        // FreeSurfer/eb251a5f-6314-457f-a36f-d11665451ddb/bf4fc87d-2e87-4309-abd9-998a0de708de
        return 0
      } else {
        // New stream name format
        // appDefName / 'default' / ecsTaskId
        // FreeSurfer/default/bf4fc87d-2e87-4309-abd9-998a0de708de
        return 1
      }
    },

    /*
         * Relate a name and version to the function to fix it
         */
    _repairStreamName(streamName, version) {
      if (version >= 1) {
        return this._renameStream(streamName)
      } else {
        return streamName
      }
    },

    /*
         * The cloudwatch stream names used by Batch changed for jobs after
         * 2017-08-21 14:00 UTC-7 and we need to translate them to support jobs
         * submitted previously
         */
    _renameStream(streamName) {
      if (streamName.indexOf('/default/') !== -1) {
        return streamName
      } else {
        let tokens = streamName.split('/')
        return [tokens[0], 'default', tokens[2]].join('/')
      }
    },

    /*
         * Some jobs were created with a string instead of an object for
         * log data
         */
    formatLegacyLogStream(stream, version = 0) {
      if (stream instanceof Object) {
        stream.name = this._repairStreamName(stream.name, version)
        return stream
      } else {
        // If it's not an object, it should be the old string format
        return {
          name: this._repairStreamName(stream, version),
          environment: null,
          exitCode: null,
        }
      }
    },
  }
}

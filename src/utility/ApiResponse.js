class ApiResponse {
    constructor(statuscode,data,message){
        this.data = data
        this.statuscode = statuscode
        this.message = message
        this.success = statuscode <= 400
    }
}
export {ApiResponse}